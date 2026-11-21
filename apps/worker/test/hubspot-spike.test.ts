import { describe, expect, it } from "vitest";
import { OPTIONAL_SCOPES, REQUIRED_SCOPES } from "@event-manager/hubspot";
import { PLACEHOLDER, runSpike, type SpikeOptions, summarise } from "../src/hubspot/spike.js";

// The spike runner (milestone 0) against a stand-in for HubSpot: it must refuse another portal
// before writing, keep going past a failing step, gate the real send, clean up, and keep tokens
// and the tester's address out of the recordings.

const TOKEN = "secret-access-token";
const EMAIL = "tester@inbox.test";

type Handler = (body: unknown, url: URL) => { status: number; body?: unknown };

/** A tiny HubSpot: routes by "METHOD /path", with :x segments matching anything. */
function hubspot(portal: number, overrides: Record<string, Handler> = {}) {
  const email: { subject?: string; content: unknown; to?: unknown; previewText?: string; state: string } = {
    content: { widgets: { button: { body: { url: PLACEHOLDER } } } },
    state: "DRAFT",
  };
  const routes: Record<string, Handler> = {
    "GET /oauth/v1/access-tokens/:t": () => ({ status: 200, body: { hub_id: portal, app_id: 9, scopes: [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES] } }),
    "GET /account-info/v3/details": () => ({ status: 200, body: { portalId: portal, accountType: "DEVELOPER_TEST", timeZone: "Europe/Oslo" } }),
    "GET /crm/v3/properties/contacts/em_guest_key": () => ({ status: 200, body: { name: "em_guest_key", groupName: "event_manager", modificationMetadata: { readOnlyValue: false } } }),
    "PATCH /crm/v3/properties/contacts/em_guest_key": () => ({ status: 400, body: { message: "readOnlyValue cannot be set" } }),
    "POST /crm/v3/objects/contacts/batch/upsert": () => ({ status: 200, body: { results: [{ id: "501", properties: { email: EMAIL, em_guest_key: "k" } }] } }),
    "POST /crm/v3/lists": () => ({ status: 200, body: { list: { listId: "77" } } }),
    "PUT /crm/v3/lists/:id/memberships/add": () => ((members = ["501"]), { status: 200, body: {} }),
    "PUT /crm/v3/lists/:id/memberships/remove": () => ((members = []), { status: 200, body: {} }),
    "GET /crm/v3/lists/:id/memberships": () => ({ status: 200, body: { results: members.map((recordId) => ({ recordId })) } }),
    "POST /marketing/v3/marketing-events/events": () => ({ status: 200, body: {} }),
    "POST /marketing/v3/marketing-events/attendance/:e/:s/email-create": () => ({ status: 200, body: {} }),
    "GET /marketing/v3/marketing-events/participations/:a/:e/breakdown": () => ({ status: 200, body: { results: [] } }),
    "GET /marketing/v3/emails": () => ({ status: 200, body: { results: [{ id: "900", name: "Invitation template", type: "BATCH_EMAIL" }] } }),
    "POST /marketing/v3/emails/clone": () => ({ status: 200, body: { id: "901" } }),
    "GET /marketing/v3/emails/:id": () => ({ status: 200, body: { id: "901", type: "BATCH_EMAIL", ...email } }),
    "PATCH /marketing/v3/emails/:id": (b) => (Object.assign(email, b), { status: 200, body: email }),
    "POST /marketing/v3/emails/:id/publish": () => ((email.state = "PUBLISHED"), { status: 204 }),
    "POST /events/v3/event-definitions": () => ({ status: 201, body: { name: "em_spike_x", fullyQualifiedName: `pe${portal}_em_spike_x` } }),
    "POST /events/v3/send": () => ({ status: 204 }),
    "DELETE /marketing/v3/emails/:id": () => ({ status: 204 }),
    "DELETE /crm/v3/lists/:id": () => ({ status: 204 }),
    "DELETE /marketing/v3/marketing-events/events/:e": () => ({ status: 204 }),
    "DELETE /events/v3/event-definitions/:n": () => ({ status: 204 }),
    "DELETE /crm/v3/objects/contacts/:id": () => ({ status: 204 }),
    ...overrides,
  };
  let members: string[] = [];
  const calls: string[] = [];
  const match = (method: string, path: string) =>
    Object.entries(routes).find(([k]) => {
      const [m, p] = k.split(" ");
      const a = p!.split("/");
      const b = path.split("/");
      return m === method && a.length === b.length && a.every((s, i) => s.startsWith(":") || s === b[i]);
    })?.[1];
  const fetchFn = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    const h = match(method, url.pathname);
    const r = h ? h(init.body ? JSON.parse(init.body as string) : undefined, url) : { status: 404, body: { message: "no route" } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls, email };
}

const opts = (o: Partial<SpikeOptions> = {}): SpikeOptions => ({ portalId: "4711", email: EMAIL, templateEmailId: "900", send: false, keep: false, attendeeUrl: "https://att.test", now: new Date("2026-11-21T12:00:00Z"), ...o });
const run = (h: ReturnType<typeof hubspot>, o?: Partial<SpikeOptions>) => runSpike(opts(o), { accessToken: TOKEN, fetch: h.fetchFn, log: () => {} });
const outcomes = (rs: { id: string; outcome: string }[]) => Object.fromEntries(rs.map((r) => [r.id, r.outcome]));

describe("HubSpot spike", () => {
  it("stops before writing anything when the token is for another portal", async () => {
    const h = hubspot(1234);
    const { results } = await run(h);
    expect(results).toEqual([expect.objectContaining({ id: "token", outcome: "fail", details: expect.arrayContaining([expect.stringContaining("not 4711")]) })]);
    expect(h.calls).toEqual(["GET /oauth/v1/access-tokens/secret-access-token"]);
  });

  it("runs every check, gates the send, and cleans up", async () => {
    const h = hubspot(4711);
    const { results, recordings } = await run(h);
    expect(outcomes(results)).toEqual({
      token: "pass", account: "info", "guest-key-property": "pass", contact: "pass", segment: "pass", "marketing-event": "pass",
      "email-clone": "pass", "email-draft": "pass", "email-send": "skip", "behavioural-events": "pass", cleanup: "info",
    });
    // The draft got the personal link in place of the placeholder, and our segment as recipients.
    expect(JSON.stringify(h.email.content)).toContain("https://att.test/h/spike-event/{{ contact.em_guest_key }}");
    expect(h.email.to).toEqual({ contactIlsLists: { include: ["77"], exclude: [] } });
    expect(h.calls).not.toContain("POST /marketing/v3/emails/901/publish");
    expect(h.calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(5);
    // Neither the token nor the tester's address is recorded.
    const text = JSON.stringify(recordings);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(EMAIL);
    expect(text).toContain("guest@example.com");
    expect(summarise(results, "4711", new Date(0))).toContain("| email-draft |");
  });

  it("publishes only with send, and keeps a sent email at cleanup", async () => {
    const h = hubspot(4711);
    const { results } = await run(h, { send: true });
    expect(outcomes(results)["email-send"]).toBe("pass");
    expect(h.email.state).toBe("PUBLISHED");
    expect(h.calls).not.toContain("DELETE /marketing/v3/emails/901");
  });

  it("records a refused step and carries on with the rest", async () => {
    const h = hubspot(4711, {
      "POST /crm/v3/lists": () => ({ status: 403, body: { category: "MISSING_SCOPES", message: "crm.lists.write" } }),
      "POST /marketing/v3/emails/:id/publish": () => ({ status: 403, body: { message: "Requires Marketing Hub Enterprise" } }),
    });
    const { results } = await run(h, { send: true, keep: true });
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(by.segment).toMatchObject({ outcome: "fail", details: [expect.stringContaining("403 MISSING_SCOPES: crm.lists.write")] });
    expect(by["marketing-event"]!.outcome).toBe("pass");
    // Without a segment the draft has no recipients to check; the rest of the draft still is.
    expect(by["email-draft"]!.outcome).toBe("pass");
    expect(by["email-send"]).toMatchObject({ outcome: "fail", details: expect.arrayContaining([expect.stringContaining("Requires Marketing Hub Enterprise")]) });
    expect(by.cleanup!.outcome).toBe("skip");
    expect(h.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("lists the portal's emails when no template is named", async () => {
    const { results } = await run(hubspot(4711), { templateEmailId: undefined });
    expect(results.find((r) => r.id === "email-clone")).toMatchObject({ outcome: "skip", details: expect.arrayContaining([expect.stringContaining('900 "Invitation template"')]) });
    expect(outcomes(results)["email-draft"]).toBe("skip");
  });
});
