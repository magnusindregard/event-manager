import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DomainError, type ErrorCode } from "@event-manager/domain";
import attendeeSpec from "../../sdk/openapi/attendee.json" with { type: "json" };
import coreSpec from "../../sdk/openapi/core.json" with { type: "json" };
import publicSpec from "../../sdk/openapi/public.json" with { type: "json" };
import { contract, ContractViolation, type Injectable, operations, type Spec } from "./openapi.js";

// The integration contract as a document (ADR 0007): what connectors rely on in the OpenAPI
// specs, and that docs/integration-guide.md lists the reasons with the statuses the API sends.

const core = coreSpec as unknown as Spec;
const specs = { core, public: publicSpec as unknown as Spec, attendee: attendeeSpec as unknown as Spec };
const guide = readFileSync(new URL("../../../docs/integration-guide.md", import.meta.url), "utf8");

const byId = (spec: Spec, id: string) => {
  const hit = operations(spec).find((o) => o.op.operationId === id);
  if (!hit) throw new Error(`no operation ${id}`);
  return hit.op;
};
const RESERVATION_WRITES = ["createReservation", "extendReservation", "confirmReservation", "cancelReservation"];

describe("the OpenAPI documents", () => {
  it.each(Object.entries(specs))("%s: every error response is a problem+json Problem", (_name, spec) => {
    expect(spec.components?.schemas?.Problem).toBeDefined();
    for (const { method, path, op } of operations(spec)) {
      for (const [status, res] of Object.entries(op.responses)) {
        if (Number(status) < 400 || !res.content) continue;
        expect(res.content["application/problem+json"], `${method} ${path} ${status}`).toEqual({ schema: { $ref: "#/components/schemas/Problem" } });
      }
    }
  });

  it("the reservations API takes channel keys and requires an Idempotency-Key on every write", () => {
    for (const id of [...RESERVATION_WRITES, "getReservation"]) expect(byId(core, id).security, id).toEqual([{ channelKey: [] }]);
    for (const id of RESERVATION_WRITES) {
      const header = byId(core, id).parameters?.find((p) => p.in === "header" && p.name === "idempotency-key");
      expect(header, id).toMatchObject({ required: true, schema: { minLength: 1, maxLength: 255 } });
      expect(Object.keys(byId(core, id).responses), id).toEqual(expect.arrayContaining(["409", "422", "428"]));
    }
    expect(byId(core, "getReservation").parameters?.some((p) => p.name === "idempotency-key")).toBe(false);
  });

  it("the public API accepts channel keys for the connector's catalog reads", () => {
    for (const id of ["listOccurrences", "getEvent"]) expect(byId(specs.public, id).security).toContainEqual({ channelKey: [] });
    expect(specs.public.components?.securitySchemes?.channelKey).toBeDefined();
  });
});

describe("the integration guide", () => {
  // | `sold_out` | 409 | … rows of the reasons table.
  const rows = [...guide.matchAll(/^\| `([a-z_]+)` \| (\d{3}) \|/gm)].map((m) => ({ code: m[1]!, status: Number(m[2]) }));

  it("lists each reason with the status the API sends", () => {
    expect(rows.length).toBeGreaterThan(15);
    // Sent by the HTTP layer (apps/api/src/plugins), not the domain.
    const http: Record<string, number> = {
      invalid_request: 400, invalid_idempotency_key: 400, unauthenticated: 401,
      idempotency_key_in_use: 409, idempotency_key_reused: 422, idempotency_key_required: 428,
    };
    for (const { code, status } of rows) expect(status, code).toBe(http[code] ?? new DomainError(code as ErrorCode, "").status);
  });

  it("documents every reason the reservations API's operations name", () => {
    const listed = new Set(rows.map((r) => r.code));
    for (const id of [...RESERVATION_WRITES, "getReservation"]) {
      const text = byId(core, id).description ?? "";
      // Reason codes are the snake_case words; field names (occurrenceId…) are camelCase.
      for (const m of text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) expect(listed, `${id}: ${m[0]}`).toContain(m[0]);
    }
  });
});

describe("the contract checks", () => {
  const fake = (status: number, body: unknown, type = "application/json"): Injectable => ({
    inject: async () => ({ statusCode: status, headers: { "content-type": type }, body: JSON.stringify(body), json: () => body }),
  });
  const { contractFetch } = contract(core);
  const id = crypto.randomUUID();
  const get = (app: Injectable) => contractFetch(app)(new Request(`https://api.test/v1/reservations/${id}`));

  it("reject a status, media type or body the spec does not have", async () => {
    await expect(get(fake(418, {}))).rejects.toThrow(ContractViolation);
    await expect(get(fake(200, { id }))).rejects.toThrow(/must have required property/);
    await expect(get(fake(404, { type: "x", title: "x", status: 404, code: "not_found" }, "text/plain"))).rejects.toThrow(/text\/plain is not in the spec/);
    await expect(get(fake(404, { type: "x", title: "x", status: 404, code: "not_found" }, "application/problem+json"))).resolves.toBeInstanceOf(Response);
  });

  it("reject a request the spec does not allow", async () => {
    const post = (headers: Record<string, string>, body: unknown) =>
      contractFetch(fake(201, {}))(new Request("https://api.test/v1/reservations", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    await expect(post({}, { lines: [] })).rejects.toThrow(/missing required header parameter idempotency-key/);
    await expect(post({ "idempotency-key": "k" }, { lines: [], price: 1 })).rejects.toThrow(/request/);
    await expect(contractFetch(fake(200, {}))(new Request("https://api.test/v1/nowhere"))).rejects.toThrow(/not in the spec/);
  });
});
