import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDb, type Db } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { tenancy } from "@event-manager/domain";
import { buildApp } from "../src/app.js";
import { DEV_ISSUER, devVerifier } from "../src/auth.js";

// The MCP server (docs/mcp.md) through the official SDK client over HTTP, as an agent uses it.

const SECRET = "test-secret";
let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let A: string;
let B: string;
const clients: Client[] = [];

const token = (email: string) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "HS256" }).setIssuer(DEV_ISSUER).setSubject(email).setExpirationTime("5m").sign(new TextEncoder().encode(SECRET));

async function connect(email: string, opts: { accountId?: string; header?: string } = {}) {
  const url = new URL(`${base}/mcp`);
  if (opts.accountId) url.searchParams.set("accountId", opts.accountId);
  const headers: Record<string, string> = { authorization: `Bearer ${await token(email)}` };
  if (opts.header) headers["account-id"] = opts.header;
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  clients.push(client);
  return client;
}

type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text: string }[] };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Result;
const ok = <T = Record<string, unknown>>(r: Result) => {
  if (r.isError) throw new Error(`Tool error: ${r.content[0]?.text}`);
  return r.structuredContent as T;
};
const text = (r: Result) => r.content.map((c) => c.text).join("\n");

async function rest(method: string, url: string, email: string, account: string, body?: unknown) {
  const res = await app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${await token(email)}`, "account-id": account }, ...(body ? { payload: body as object } : {}) });
  return res.json() as Record<string, unknown>;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildApp({ db, verifier: devVerifier(SECRET), mcp: { authorizationServers: ["https://login.example/tenant/v2.0"], scopes: ["api://em-api/access"] } });
  base = await app.listen({ port: 0, host: "127.0.0.1" });
  A = (await tenancy.createAccount(db, { slug: "mcp-a", name: "Museum A", ownerEmail: "owner@a.test" })).id;
  B = (await tenancy.createAccount(db, { slug: "mcp-b", name: "Museum B", ownerEmail: "owner@b.test" })).id;
  for (const email of ["owner@a.test", "owner@b.test"]) await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${await token(email)}` } });
  // finance@a.test may read but not change events; both@x.test belongs to A and B.
  await rest("POST", "/v1/account/invitations", "owner@a.test", A, { email: "finance@a.test", role: "finance" });
  await rest("POST", "/v1/account/invitations", "owner@a.test", A, { email: "both@x.test", role: "editor" });
  await rest("POST", "/v1/account/invitations", "owner@b.test", B, { email: "both@x.test", role: "editor" });
  for (const email of ["finance@a.test", "both@x.test"]) await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${await token(email)}` } });
});
afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("MCP authentication", () => {
  it("refuses a request without a token and points to the sign-in metadata", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="api://em-api/access"`);

    const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(meta).toMatchObject({ resource: `${base}/mcp`, authorization_servers: ["https://login.example/tenant/v2.0"], scopes_supported: ["api://em-api/access"] });
  });

  it("refuses an invalid token", async () => {
    const client = new Client({ name: "x", version: "1" });
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer nope" } } }))).rejects.toThrow();
  });

  it("is stateless: GET and DELETE are 405", async () => {
    const res = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${await token("owner@a.test")}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("MCP catalogue", () => {
  it("lists documented tools with input schemas and hints", async () => {
    const c = await connect("owner@a.test");
    expect(c.getInstructions()).toContain("create-event");
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "whoami", "get_event_configuration", "get_account", "list_events", "get_event", "list_occurrences", "list_series", "list_offers", "list_rules",
      "list_locations", "list_tags", "list_user_groups", "list_vat_classes", "create_event", "update_event", "publish_event", "unpublish_event", "cancel_event",
      "create_series", "update_series", "create_occurrence", "update_occurrence", "create_offer", "update_offer", "create_rule", "update_rule", "create_location",
    ]));
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_events!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.publish_event!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.create_event!.inputSchema.required).toEqual(["translations"]);
    expect(Object.keys(byName.create_event!.inputSchema.properties!)).toContain("idempotencyKey");
    expect(byName.update_event!.inputSchema.required).toEqual(["eventId", "version"]);
    expect(byName.list_events!.inputSchema.required).toBeUndefined();
    expect(byName.create_series!.inputSchema.required).toEqual(["eventId", "rrule", "dtstartLocal"]);
  });

  it("serves the companion skills as prompts", async () => {
    const c = await connect("owner@a.test");
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["configure-event", "create-event", "review-event"]);
    const p = await c.getPrompt({ name: "create-event" });
    const body = (p.messages[0]!.content as { text: string }).text;
    expect(body).toMatch(/^# Create an event with your human/);
    expect(body).not.toContain("description:");
    await expect(c.getPrompt({ name: "nope" })).rejects.toThrow(/Unknown prompt/);
  });
});

describe("MCP accounts", () => {
  it("uses the user's only account", async () => {
    const me = ok<{ activeAccount: { accountId: string; roles: string[] } }>(await call(await connect("owner@a.test"), "whoami"));
    expect(me.activeAccount).toMatchObject({ accountId: A, roles: ["owner"] });
  });

  it("asks which account when the user has several, and takes ?accountId= or the header", async () => {
    const none = await connect("both@x.test");
    const who = ok<{ activeAccount: unknown; accounts: unknown[]; note: string }>(await call(none, "whoami"));
    expect(who.activeAccount).toBeNull();
    expect(who.accounts).toHaveLength(2);
    const refused = await call(none, "list_events");
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("No account selected");
    expect(text(refused)).toContain(A);

    expect(ok<{ activeAccount: { accountId: string } }>(await call(await connect("both@x.test", { accountId: B }), "whoami")).activeAccount.accountId).toBe(B);
    expect(ok<{ activeAccount: { accountId: string } }>(await call(await connect("both@x.test", { header: A }), "whoami")).activeAccount.accountId).toBe(A);
  });

  it("refuses an account the user is not a member of", async () => {
    const r = await call(await connect("owner@b.test", { accountId: A }), "list_events");
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("MCP event management", () => {
  let c: Client;
  let eventId: string;
  let venueId: string;
  let version: number;

  beforeAll(async () => {
    c = await connect("owner@a.test");
  });

  it("creates a location and a draft event, idempotently", async () => {
    venueId = ok<{ id: string }>(await call(c, "create_location", { kind: "venue", name: "Main building" })).id;
    const args = {
      translations: { nb: { title: "Omvisning", shortDescription: "En times omvisning" }, en: { title: "Guided tour" } },
      defaultLocationId: venueId, defaultDurationMin: 60, admissionMode: "registration", registration: { capacity: 25, waitlistEnabled: true },
      idempotencyKey: "tour-1",
    };
    const first = ok<{ id: string; status: string; version: number; registration: { capacity: number } }>(await call(c, "create_event", args));
    expect(first).toMatchObject({ status: "draft", registration: { capacity: 25 } });
    const again = ok<{ id: string }>(await call(c, "create_event", args));
    expect(again.id).toBe(first.id);
    eventId = first.id;
    version = first.version;
  });

  it("explains validation errors in terms of the arguments", async () => {
    const missing = await call(c, "create_event", { defaultDurationMin: 0 });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("invalid_request");
    expect(text(missing)).toContain("- (arguments): must have required property 'translations'");
    const tooShort = await call(c, "create_event", { translations: { nb: { title: "X" } }, defaultDurationMin: 0 });
    expect(text(tooShort)).toContain("- defaultDurationMin: must be >= 1");

    const unknown = await call(c, "create_event", { title: "Omvisning" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain("Unknown argument title");

    const wrongPlace = await call(c, "create_event", { translations: { nb: { title: "X" } }, defaultLocationId: "00000000-0000-4000-8000-000000000000" });
    expect(wrongPlace.isError).toBe(true);
    expect(wrongPlace.structuredContent).toMatchObject({ error: { code: "validation_failed", status: 422 } });
  });

  it("finds events and reads one", async () => {
    const found = ok<{ items: { id: string }[] }>(await call(c, "list_events", { q: "omvisning" }));
    expect(found.items.map((e) => e.id)).toEqual([eventId]);
    expect(ok<{ items: unknown[] }>(await call(c, "list_events", { q: "concert" })).items).toEqual([]);
    expect(ok(await call(c, "get_event", { eventId }))).toMatchObject({ id: eventId, translations: { en: { title: "Guided tour" } } });
    const missing = await call(c, "get_event", { eventId: "00000000-0000-4000-8000-000000000000" });
    expect(missing.structuredContent).toMatchObject({ error: { code: "not_found" } });
    expect(text(missing)).toContain("list tool");
  });

  it("updates with the version and refuses a stale one with what to do", async () => {
    const updated = ok<{ version: number; registration: { capacity: number; waitlistEnabled: boolean } }>(
      await call(c, "update_event", { eventId, version, registration: { capacity: 30 } }),
    );
    expect(updated.registration).toMatchObject({ capacity: 30, waitlistEnabled: true });
    const stale = await call(c, "update_event", { eventId, version, defaultDurationMin: 90 });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({ error: { code: "version_conflict", status: 412, details: { currentVersion: updated.version } } });
    expect(text(stale)).toContain("Read it again");
    const noVersion = await call(c, "update_event", { eventId, defaultDurationMin: 90 });
    expect(noVersion.isError).toBe(true);
    expect(text(noVersion)).toContain("version is required");
    version = updated.version;
  });

  it("previews a series, then adds it", async () => {
    const series = { eventId, rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=4", dtstartLocal: "2027-03-02T14:00" };
    const preview = ok<{ series: unknown; changes: { counts: { created: number } } }>(await call(c, "create_series", { ...series, dryRun: true }));
    expect(preview.series).toBeNull();
    expect(preview.changes.counts.created).toBe(4);
    expect(ok<{ items: unknown[] }>(await call(c, "list_occurrences", { eventId })).items).toHaveLength(0);
    ok(await call(c, "create_series", { ...series, idempotencyKey: "tour-series" }));
    const occ = ok<{ items: { startUtc: string }[] }>(await call(c, "list_occurrences", { eventId, from: "2027-01-01T00:00:00Z" }));
    expect(occ.items.map((o) => o.startUtc)).toEqual(["2027-03-02T13:00:00.000Z", "2027-03-09T13:00:00.000Z", "2027-03-16T13:00:00.000Z", "2027-03-23T13:00:00.000Z"]);
  });

  it("returns the whole configuration in one call", async () => {
    const conf = ok<{ event: { id: string }; series: unknown[]; occurrences: { items: unknown[]; more: boolean }; offers: unknown[]; rules: unknown[] }>(
      await call(c, "get_event_configuration", { eventId, from: "2027-01-01T00:00:00Z", occurrenceLimit: 3 }),
    );
    expect(conf.event.id).toBe(eventId);
    expect(conf.series).toHaveLength(1);
    expect(conf.occurrences.items).toHaveLength(3);
    expect(conf.occurrences.more).toBe(true);
    expect(conf.offers).toEqual([]);
    expect(conf.rules).toEqual([]);
    expect((await call(c, "get_event_configuration", { eventId: "nope" })).isError).toBe(true);
  });

  it("previews and adds a rule, and publishes on request", async () => {
    const rule = { eventId, name: "Bigger groups in March", conditions: { dateFrom: "2027-03-15", dateTo: "2027-03-31" }, effects: [{ type: "capacity", value: 40 }] };
    const preview = ok<{ rule: unknown; preview: { counts: { matched: number } } }>(await call(c, "create_rule", { ...rule, dryRun: true }));
    expect(preview.rule).toBeNull();
    expect(preview.preview.counts.matched).toBe(2);
    expect(ok<{ rule: { id: string } }>(await call(c, "create_rule", rule)).rule.id).toBeTruthy();
    expect(ok<{ status: string }>(await call(c, "publish_event", { eventId, version })).status).toBe("published");
  });

  it("respects the user's role", async () => {
    const finance = await connect("finance@a.test");
    expect(ok<{ items: { id: string }[] }>(await call(finance, "list_events")).items.map((e) => e.id)).toContain(eventId);
    const denied = await call(finance, "create_event", { translations: { nb: { title: "Nei" } } });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({ error: { code: "forbidden", status: 403 } });
    expect(text(denied)).toContain("role");
  });

  it("keeps accounts apart", async () => {
    const other = await connect("owner@b.test");
    expect(ok<{ items: unknown[] }>(await call(other, "list_events")).items).toEqual([]);
    expect((await call(other, "get_event", { eventId })).structuredContent).toMatchObject({ error: { code: "not_found" } });
  });
});
