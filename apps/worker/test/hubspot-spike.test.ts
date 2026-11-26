import { describe, expect, it } from "vitest";
import { OPTIONAL_SCOPES, REQUIRED_SCOPES } from "@event-manager/hubspot";
import { PLACEHOLDER, runSpike, SINGLE_SEND_LINK, type SpikeOptions, summarise } from "../src/hubspot/spike.js";

// The spike runner (milestone 0) against a stand-in for HubSpot: it must refuse another portal
// before writing, keep going past a failing step, gate the real send, clean up, and keep tokens
// and the tester's address out of the recordings.

const TOKEN = "secret-access-token";
const EMAIL = "tester@inbox.test";

type Handler = (body: unknown, url: URL) => { status: number; body?: unknown };

/** A tiny HubSpot: routes by "METHOD /path", with :x segments matching anything. */
function hubspot(portal: number, overrides: Record<string, Handler> = {}) {
  // Like the real template in run 1: its own recipient list, and preview text as a module.
  const email: { subject?: string; content: unknown; to?: unknown; subscriptionDetails?: unknown; state: string } = {
    content: { widgets: { button: { body: { url: PLACEHOLDER } }, preview_text: { body: { value: "" } } } },
    to: { contactIlsLists: { include: [], exclude: [] }, contactLists: { include: [], exclude: [] }, contactIds: { include: [], exclude: [] } },
    subscriptionDetails: { officeLocationId: "1" },
    state: "DRAFT",
  };
  // Other emails by id: 950 is a single-send template the client made in HubSpot.
  const emails: Record<string, Record<string, unknown>> = {
    "901": email as unknown as Record<string, unknown>,
    "950": { id: "950", type: "AUTOMATED_EMAIL", subcategory: "single_send_api", state: "DRAFT", subscriptionDetails: { subscriptionId: "222" }, content: { widgets: { button: { body: { url: PLACEHOLDER } } } } },
  };
  let nextId = 960;
  let batchCloned = false;
  let breakdownReads = 0;
  // Contacts by email, with the marketing flag; single-send sets it (as HubSpot says it does).
  const contacts = new Map<string, { id: string; marketable: boolean }>([[EMAIL, { id: "501", marketable: true }]]);
  const sends = new Map<string, { to: string; customProperties: Record<string, string> }>();
  // Subscription status per address and type; an EU portal that wants a legal basis on writes.
  const prefs = new Map<string, Record<string, string>>();
  const results = new Map<string, string>();
  const flows: Record<string, unknown> = { f1: { id: "f1", name: "Set marketing", actions: [{ actionTypeId: "0-31", fields: { marketable_status: "true" } }] } };
  const contactBody = (email: string) => {
    const c = contacts.get(email)!;
    return { id: c.id, properties: { email, hs_marketable_status: String(c.marketable) } };
  };
  const singleSend: Handler = (b) => {
    const { emailId, message, customProperties } = b as { emailId: number; message: { to: string; sendId: string }; customProperties: Record<string, string> };
    // Like real HubSpot (run 7): a single-send email must be published.
    if (emails[String(emailId)]?.state !== "PUBLISHED") return { status: 400, body: { message: `Email is in a draft state -- emailId: ${emailId}` } };
    if (sends.has(message.sendId)) return { status: 201, body: { statusId: `s-${message.sendId}`, status: "COMPLETE", sendResult: "IDEMPOTENT_IGNORE" } };
    sends.set(message.sendId, { to: message.to, customProperties });
    const type = String((emails[String(emailId)]?.subscriptionDetails as { subscriptionId?: string } | undefined)?.subscriptionId);
    results.set(`s-${message.sendId}`, prefs.get(message.to)?.[type] === "UNSUBSCRIBED" ? "PREVIOUSLY_UNSUBSCRIBED_MESSAGE" : "SENT");
    const c = contacts.get(message.to) ?? { id: String(nextId++), marketable: false };
    contacts.set(message.to, { ...c, marketable: true });
    return { status: 201, body: { statusId: `s-${message.sendId}`, status: "PENDING" } };
  };
  const routes: Record<string, Handler> = {
    "GET /oauth/v1/access-tokens/:t": () => ({ status: 200, body: { hub_id: portal, app_id: 9, scopes: [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES] } }),
    "GET /account-info/v3/details": () => ({ status: 200, body: { portalId: portal, accountType: "DEVELOPER_TEST", timeZone: "Europe/Oslo" } }),
    "GET /crm/v3/properties/contacts/em_guest_key": () => ({ status: 200, body: { name: "em_guest_key", groupName: "event_manager", modificationMetadata: { readOnlyValue: false } } }),
    "PATCH /crm/v3/properties/contacts/em_guest_key": () => ({ status: 200, body: { modificationMetadata: { readOnlyValue: false } } }),
    "POST /crm/v3/objects/contacts/batch/upsert": (b) => {
      const e = (b as { inputs: { id: string }[] }).inputs[0]!.id;
      if (!contacts.has(e)) contacts.set(e, { id: String(nextId++), marketable: false });
      return { status: 200, body: { results: [{ ...contactBody(e), properties: { ...contactBody(e).properties, em_guest_key: "k" } }] } };
    },
    "GET /crm/v3/objects/contacts/:id": (_b, url) => {
      const hit = [...contacts].find(([, c]) => c.id === url.pathname.split("/").at(-1));
      return hit ? { status: 200, body: contactBody(hit[0]) } : { status: 404, body: { message: "no contact" } };
    },
    "POST /crm/v3/objects/contacts/search": (b) => {
      const e = (b as { filterGroups: { filters: { value: string }[] }[] }).filterGroups[0]!.filters[0]!.value;
      return { status: 200, body: contacts.has(e) ? { total: 1, results: [contactBody(e)] } : { total: 0, results: [] } };
    },
    "POST /marketing/email-campaigns/2026-09/single-send": () => ({ status: 404, body: { message: "not here" } }),
    "POST /marketing/v4/email/single-send": singleSend,
    "GET /marketing/v3/email/send-statuses/:id": (_b, url) => ({ status: 200, body: { status: "COMPLETE", sendResult: results.get(url.pathname.split("/").at(-1)!) ?? "SENT" } }),
    "GET /communication-preferences/v4/definitions": () => ({ status: 200, body: { results: [{ id: 222, name: "Invitasjoner" }, { id: 333, name: "Nyhetsbrev" }] } }),
    "POST /communication-preferences/v4/statuses/batch/write": () => ({ status: 200, body: { status: "COMPLETE", results: [] } }),
    "POST /communication-preferences/v4/statuses/batch/unsubscribe-all": () => ({ status: 200, body: { status: "COMPLETE", results: [] } }),
    "GET /communication-preferences/v4/statuses/:email": (_b, url) => {
      const e = decodeURIComponent(url.pathname.split("/").at(-1)!);
      return { status: 200, body: { results: ["222", "333"].map((id) => ({ subscriptionId: Number(id), status: prefs.get(e)?.[id] ?? "NOT_SPECIFIED" })) } };
    },
    "POST /communication-preferences/v4/statuses/:email": (b, url) => {
      const { subscriptionId, statusState, legalBasis } = b as { subscriptionId: number; statusState: string; legalBasis?: string };
      if (!legalBasis) return { status: 400, body: { category: "VALIDATION_ERROR", message: "legalBasis is required when data privacy settings are on" } };
      const e = decodeURIComponent(url.pathname.split("/").at(-1)!);
      prefs.set(e, { ...prefs.get(e), [String(subscriptionId)]: statusState });
      return { status: 200, body: { subscriptionId, status: statusState } };
    },
    "PATCH /crm/v3/objects/contacts/:id": () => ({ status: 400, body: { category: "VALIDATION_ERROR", message: "hs_marketable_status is a read only property" } }),
    "GET /automation/v4/flows": () => ({ status: 200, body: { results: Object.keys(flows).map((id) => ({ id })) } }),
    "GET /automation/v4/flows/:id": (_b, url) => {
      const f = flows[url.pathname.split("/").at(-1)!];
      return f ? { status: 200, body: f } : { status: 404, body: { message: "no flow" } };
    },
    "POST /automation/v4/flows": (b) => ((flows.f9 = { ...(b as object), id: "f9" }), { status: 201, body: { id: "f9" } }),
    "DELETE /automation/v4/flows/:id": () => ({ status: 204 }),
    "POST /crm/v3/lists": () => ({ status: 200, body: { list: { listId: "77" } } }),
    "PUT /crm/v3/lists/:id/memberships/add": () => ((members = ["501"]), { status: 200, body: {} }),
    "PUT /crm/v3/lists/:id/memberships/remove": () => ((members = []), { status: 200, body: {} }),
    "GET /crm/v3/lists/:id/memberships": () => ({ status: 200, body: { results: members.map((recordId) => ({ recordId })) } }),
    "POST /marketing/v3/marketing-events/events": () => ({ status: 200, body: {} }),
    "POST /marketing/v3/marketing-events/attendance/:e/:s/email-create": () => ({ status: 200, body: {} }),
    // Like real HubSpot (run 17): attendance shows up on a later read, not straight away.
    "GET /marketing/v3/marketing-events/participations/:a/:e/breakdown": () => (breakdownReads++ < 1 ? { status: 200, body: { total: 0, results: [] } } : { status: 200, body: { total: 1, results: [{ properties: { attendanceState: "ATTENDED" } }] } }),
    "GET /communication-preferences/v3/definitions": () => ({ status: 200, body: { subscriptionDefinitions: [{ id: "111", name: "Nyhetsbrev" }, { id: "222", name: "Informasjon fra Munchmuseet" }] } }),
    "GET /marketing/v3/emails": () => ({ status: 200, body: { results: [{ id: "900", name: "Invitation template", type: "BATCH_EMAIL" }] } }),
    "POST /marketing/v3/emails/clone": (b) => {
      const from = (b as { id: string }).id;
      // The first clone of the batch template is the draft (901); every clone gets its own id.
      if (from === "900" && !batchCloned) return (batchCloned = true), { status: 200, body: { id: "901" } };
      const id = String(nextId++);
      const source = from === "900" ? { type: "BATCH_EMAIL", subscriptionDetails: { subscriptionId: "222" }, content: { widgets: { button: { body: { url: PLACEHOLDER } } } } } : emails[from];
      // Like real HubSpot (run 10): a clone starts as a draft, even of a published email.
      emails[id] = JSON.parse(JSON.stringify({ ...source, id, state: "DRAFT" }));
      return { status: 200, body: { id } };
    },
    "GET /marketing/v3/emails/:id": (_b, url) => {
      const id = url.pathname.split("/").at(-1)!;
      return id === "901" ? { status: 200, body: { id: "901", type: "BATCH_EMAIL", ...email } } : emails[id] ? { status: 200, body: emails[id] } : { status: 404, body: { message: "no email" } };
    },
    // Like real HubSpot (run 3): a segment set as recipients also appears under its legacy id.
    "PATCH /marketing/v3/emails/:id": (b, url) => {
      const id = url.pathname.split("/").at(-1)!;
      // Like a HubSpot that ignores a type change through the API.
      const { type: _t, subcategory: _s, ...rest } = b as Record<string, unknown>;
      if (id !== "901") return emails[id] ? (Object.assign(emails[id]!, rest), { status: 200, body: emails[id] }) : { status: 404, body: {} };
      Object.assign(email, rest);
      const to = (b as { to?: { contactIlsLists?: { include?: string[] } } }).to;
      if (to?.contactIlsLists?.include?.length) (email.to as Record<string, unknown>).contactLists = { include: to.contactIlsLists.include.map((id) => String(Number(id) + 744)), exclude: [] };
      return { status: 200, body: email };
    },
    "GET /crm/v3/lists/idmapping": (_b, url) => {
      const legacy = url.searchParams.get("legacyListId")!;
      return Number(legacy) === 77 + 744 ? { status: 200, body: { legacyListId: legacy, listId: "77" } } : { status: 404, body: { message: "unknown legacy list" } };
    },
    "POST /marketing/v3/emails/:id/publish": (_b, url) => {
      const id = url.pathname.split("/").at(-2)!;
      if (emails[id] && id !== "901") emails[id]!.state = "PUBLISHED";
      else email.state = "PUBLISHED";
      return { status: 204 };
    },
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
  return { fetchFn, calls, email, emails, contacts, sends, prefs, flows };
}

const opts = (o: Partial<SpikeOptions> = {}): SpikeOptions => ({ portalId: "4711", email: EMAIL, templateEmailId: "900", subscription: "informasjon fra munchmuseet", send: false, keep: false, attendeeUrl: "https://att.test", now: new Date("2026-11-21T12:00:00Z"), ...o });
const run = (h: ReturnType<typeof hubspot>, o?: Partial<SpikeOptions>) => runSpike(opts(o), { accessToken: TOKEN, fetch: h.fetchFn, log: () => {}, sleep: async () => {} });
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
      "marketing-event-attendance": "pass", "subscription-types": "pass", "email-clone": "pass", "email-draft": "pass", "email-send": "skip",
      "single-send-email": "fail", "single-send-contacts": "pass", "single-send": "skip", "single-send-marketing": "skip",
      "subscription-types-v4": "pass", "subscription-write": "pass", "subscription-blocks": "skip", "unsubscribe-all": "info", "marketable-write": "skip", workflow: "pass",
      "behavioural-events": "pass", cleanup: "info",
    });
    // The draft got the personal link in place of the placeholder, and our segment as recipients.
    expect(JSON.stringify(h.email.content)).toContain("https://att.test/h/spike-event/{{ contact.em_guest_key }}");
    expect(h.email.to).toMatchObject({ contactIlsLists: { include: ["77"], exclude: [] }, contactIds: { include: [], exclude: [] } });
    expect(results.find((r) => r.id === "email-draft")!.details).toContain("recipients contactIlsLists:77, contactLists:821 (= contactIlsLists:77)");
    expect(JSON.stringify(h.email.content)).toContain('"preview_text":{"body":{"value":"Preview');
    // The subscription type is found by name and set on the draft, keeping the rest of the details.
    expect(h.email.subscriptionDetails).toEqual({ officeLocationId: "1", subscriptionId: "222" });
    expect(h.calls).not.toContain("POST /marketing/v3/emails/901/publish");
    // Five as before, plus our single-send clone, its existing-contact recipient and the workflow.
    expect(h.calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(8);
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
    expect(h.calls).not.toContain("DELETE /crm/v3/lists/77");
    expect(h.calls).not.toContain("DELETE /crm/v3/objects/contacts/501");
  });

  it("records a refused step and carries on, but never publishes without our segment", async () => {
    const h = hubspot(4711, { "POST /crm/v3/lists": () => ({ status: 403, body: { category: "MISSING_SCOPES", message: "crm.lists.write" } }) });
    const { results } = await run(h, { send: true, keep: true });
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(by.segment).toMatchObject({ outcome: "fail", details: [expect.stringContaining("403 MISSING_SCOPES: crm.lists.write")] });
    expect(by["marketing-event"]!.outcome).toBe("pass");
    expect(by["email-send"]!.outcome).toBe("skip");
    expect(h.calls).not.toContain("POST /marketing/v3/emails/901/publish");
    expect(by.cleanup!.outcome).toBe("skip");
    expect(h.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("does not publish when the draft has recipients other than our segment", async () => {
    const h = hubspot(4711, {
      // A HubSpot that merges recipients instead of replacing them.
      "PATCH /marketing/v3/emails/:id": (b) => {
        const { to, ...rest } = b as { to?: { contactIlsLists: unknown } };
        Object.assign(h.email, rest);
        if (to) (h.email.to as Record<string, unknown>).contactIlsLists = to.contactIlsLists;
        (h.email.to as Record<string, unknown>).contactLists = { include: ["781"], exclude: [] };
        return { status: 200, body: h.email };
      },
    });
    const { results } = await run(h, { send: true });
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(by["email-draft"]).toMatchObject({ outcome: "fail", details: expect.arrayContaining(["onlyOurSegment ✗", "recipients contactIlsLists:77, contactLists:781"]) });
    expect(by["email-send"]).toMatchObject({ outcome: "skip", details: [expect.stringContaining("not only our segment")] });
    expect(h.calls).not.toContain("POST /marketing/v3/emails/901/publish");
  });

  it("names HubSpot's validation errors when publishing is refused", async () => {
    const h = hubspot(4711, {
      "POST /marketing/v3/emails/:id/publish": () => ({ status: 400, body: { message: "There were errors validating your email.", errors: [{ errorType: "CAN_SPAM_NOT_CONFIGURED" }, { errorType: "NOT_SET" }] } }),
    });
    const { results } = await run(h, { send: true });
    expect(results.find((r) => r.id === "email-send")).toMatchObject({ outcome: "fail", details: expect.arrayContaining([expect.stringContaining("[CAN_SPAM_NOT_CONFIGURED, NOT_SET]")]) });
  });

  it("lists the portal's emails when no template is named", async () => {
    const { results } = await run(hubspot(4711), { templateEmailId: undefined });
    expect(results.find((r) => r.id === "email-clone")).toMatchObject({ outcome: "skip", details: expect.arrayContaining([expect.stringContaining('900 "Invitation template"')]) });
    expect(outcomes(results)["email-draft"]).toBe("skip");
  });

  it("reports a subscription type that does not exist, or a list it may not read", async () => {
    const missing = await run(hubspot(4711), { subscription: "Finnes ikke" });
    expect(missing.results.find((r) => r.id === "subscription-types")).toMatchObject({ outcome: "fail", details: expect.arrayContaining(['no subscription type matches "Finnes ikke"']) });
    const refused = await run(hubspot(4711, { "GET /communication-preferences/v3/definitions": () => ({ status: 403, body: { category: "MISSING_SCOPES", message: "communication_preferences.read" } }) }), { subscription: "333" });
    expect(refused.results.find((r) => r.id === "subscription-types")).toMatchObject({ outcome: "fail", details: ["list: 403 MISSING_SCOPES: communication_preferences.read", "using id 333 as given"] });
  });

  describe("single-send", () => {
    it("works on a clone of the named single-send template, sends to both recipients once each, and sees them become marketing contacts", async () => {
      const h = hubspot(4711);
      const { results, recordings } = await run(h, { send: true, singleSendEmailId: "950" });
      const by = Object.fromEntries(results.map((r) => [r.id, r]));
      expect(by["single-send-email"]).toMatchObject({ outcome: "pass", details: expect.arrayContaining([expect.stringContaining("(kept the single-send type)")]) });
      // The client's template is untouched; the clone carries the custom property.
      expect(JSON.stringify(h.emails["950"])).toContain(PLACEHOLDER);
      const clone = Object.entries(h.emails).find(([id]) => id !== "950" && id !== "901")![1];
      expect(JSON.stringify(clone)).toContain(`https://att.test/i/${SINGLE_SEND_LINK}`);
      expect(by["single-send-contacts"]!.outcome).toBe("pass");
      expect(by["single-send"]).toMatchObject({ outcome: "pass", details: expect.arrayContaining([expect.stringContaining("published the clone: 204, state PUBLISHED"), expect.stringContaining("endpoint /marketing/v4/email/single-send"), expect.stringContaining("IDEMPOTENT_IGNORE"), "existing status: COMPLETE, sendResult SENT"]) });
      // One send each, with its own link, despite the repeated sendId.
      expect([...h.sends].filter(([id]) => /-(existing|fresh|plain)$/.test(id)).map(([, s]) => s.customProperties.invitation_token)).toEqual([expect.stringMatching(/^spike-existing-/), expect.stringMatching(/^spike-fresh-/), expect.stringMatching(/^spike-plain-/)]);
      expect(by["single-send-marketing"]).toMatchObject({ outcome: "pass", details: [expect.stringContaining("marketable false → true"), expect.stringContaining("marketable ∅ → true"), expect.stringContaining("plain: contact 501")] });
      // Sent: the clone and both contacts stay for the timeline.
      const cloneId = Object.keys(h.emails).find((id) => id !== "950" && id !== "901")!;
      expect(h.calls).not.toContain(`DELETE /marketing/v3/emails/${cloneId}`);
      // The plus addresses are redacted like the tester's own.
      const text = JSON.stringify(recordings);
      expect(text).not.toMatch(/tester(\+[\w.-]+)?@inbox\.test/);
      expect(text).toContain("guest+em-");
    });

    it("does not send without --send, and cleans up the clone and contact", async () => {
      const h = hubspot(4711);
      const { results } = await run(h, { singleSendEmailId: "950" });
      expect(outcomes(results)["single-send"]).toBe("skip");
      expect(h.sends.size).toBe(0);
      expect(h.calls.filter((c) => c.startsWith("DELETE /marketing/v3/emails/") && !c.endsWith("/901"))).toHaveLength(1);
    });

    it("uses a named email that already carries the link as it is", async () => {
      const h = hubspot(4711);
      h.emails["950"]!.content = { widgets: { button: { body: { url: SINGLE_SEND_LINK } } } };
      h.emails["950"]!.state = "PUBLISHED";
      const { results } = await run(h, { send: true, singleSendEmailId: "950" });
      expect(results.find((r) => r.id === "single-send-email")!.details).toContain(`${SINGLE_SEND_LINK} found in content`);
      expect(h.calls.filter((c) => c === "POST /marketing/v3/emails/clone")).toHaveLength(1); // only the batch template
    });
  });

  describe("cleanup checks", () => {
    it("unsubscribes and restores on the throwaway address with a legal basis, then shows the other type blocked on the test address and puts it back", async () => {
      const h = hubspot(4711);
      const { results } = await run(h, { send: true, singleSendEmailId: "950" });
      const by = Object.fromEntries(results.map((r) => [r.id, r]));
      expect(by["subscription-types-v4"]).toMatchObject({ outcome: "pass", details: expect.arrayContaining(["event type (the single-send email's): 222", "other type for the checks: 333"]) });
      expect(by["subscription-write"]).toMatchObject({ outcome: "pass", details: expect.arrayContaining([expect.stringContaining("(needed a legal basis) → UNSUBSCRIBED"), expect.stringContaining("NOT_SPECIFIED: 200 → NOT_SPECIFIED")]) });
      expect(by["subscription-blocks"]).toMatchObject({ outcome: "pass", details: expect.arrayContaining(["event-type: COMPLETE, sendResult SENT", "other-type: COMPLETE, sendResult PREVIOUSLY_UNSUBSCRIBED_MESSAGE", expect.stringContaining("test address restored to NOT_SPECIFIED")]) });
      expect(h.prefs.get(EMAIL)).toEqual({ "333": "NOT_SPECIFIED" });
      expect(by["marketable-write"]).toMatchObject({ outcome: "fail", details: expect.arrayContaining([expect.stringContaining("read only")]) });
      // The workflow copies the portal's marketing action with the value flipped, disabled, enrolled on our segment.
      expect(by.workflow!.outcome).toBe("pass");
      expect(h.flows.f9).toMatchObject({ isEnabled: false, actions: [{ actionTypeId: "0-31", fields: { marketable_status: "false" } }] });
      expect(JSON.stringify(h.flows.f9)).toContain('"listId":"77"');
      expect(h.calls).toContain("DELETE /automation/v4/flows/f9");
    });

    it("never touches the test address when a status cannot be set back", async () => {
      const h = hubspot(4711, {
        "POST /communication-preferences/v4/statuses/:email": (b) => ((b as { statusState: string }).statusState === "NOT_SPECIFIED" ? { status: 400, body: { message: "cannot set NOT_SPECIFIED" } } : { status: 200, body: {} }),
      });
      const { results } = await run(h, { send: true, singleSendEmailId: "950" });
      const by = Object.fromEntries(results.map((r) => [r.id, r]));
      expect(by["subscription-write"]!.outcome).toBe("fail");
      expect(by["subscription-blocks"]).toMatchObject({ outcome: "skip", details: [expect.stringContaining("test address is not touched")] });
      expect(h.calls.filter((c) => c.startsWith("POST /communication-preferences/v4/statuses/") && c.includes(encodeURIComponent(EMAIL)))).toEqual([]);
    });

    it("skips the cleanup checks when the portal has not granted the scopes", async () => {
      const h = hubspot(4711, { "GET /oauth/v1/access-tokens/:t": () => ({ status: 200, body: { hub_id: 4711, app_id: 9, scopes: [...REQUIRED_SCOPES] } }) });
      const { results } = await run(h);
      expect(outcomes(results)).toMatchObject({ "subscription-types-v4": "skip", workflow: "skip", "behavioural-events": "skip" });
      expect(h.calls.some((c) => c.includes("communication-preferences/v4"))).toBe(false);
    });
  });
});
