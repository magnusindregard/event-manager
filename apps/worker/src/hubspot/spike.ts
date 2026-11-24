import { randomBytes } from "node:crypto";
import { BEHAVIOURAL_EVENT_SCOPES, CLEANUP_SCOPES, OPTIONAL_SCOPES, REQUIRED_SCOPES } from "@event-manager/hubspot";

// The guest key from the first design (runs 1–6); no longer part of the connector, kept here so
// the spike's early checks still run as they did.
const PROPERTY_GROUP = { name: "event_manager", label: "Event manager" } as const;
const GUEST_KEY_PROPERTY = { name: "em_guest_key", label: "Event manager guest key", description: "Spike only.", groupName: PROPERTY_GROUP.name } as const;

// HubSpot connector milestone 0, the spike (docs/hubspot.md): checks what milestones 2–6 assume
// about HubSpot, on a developer test portal, and records every answer. Each step stands alone:
// a step that fails is a finding, not a reason to stop. Only a token for another portal than the
// one named stops the run, so it never writes to a real portal by mistake.
//
// It writes to the portal: a test contact (your own address), a static segment, a marketing
// event with attendance, a clone of a template email, and with the optional scopes a custom
// event definition. Cleanup removes them unless `keep` is set. Publishing the email sends a
// real email to the test contact, so it only runs with `send`.
//
// The single-send steps try HubSpot's third way of sending, the marketing single-send API: the
// platform sends one email per guest, with the guest's own link as a custom property. They use
// two plus addresses of `email` (one an existing non-marketing contact, one with no contact), and
// with `send` they send to both, which HubSpot says makes them marketing contacts.

export interface SpikeOptions {
  /** The portal the token must belong to. */
  portalId: string;
  /** The test contact; use an inbox you can read. Redacted from the recordings. */
  email: string;
  /** A marketing email designed as a template, with [[em:invitation_link]] in it. */
  templateEmailId?: string;
  /** Subscription type for the draft, by id or name; HubSpot will not publish without one. */
  subscription?: string;
  /** Publish the draft: sends a real email to `email`. */
  send: boolean;
  /** Leave what the spike created in the portal. */
  keep: boolean;
  /** An email set up for the single-send API in HubSpot; without it the spike tries to make one from the template. */
  singleSendEmailId?: string;
  /** How long to keep reading marketing event attendance (default five minutes). */
  attendanceWaitMs?: number;
  /** Send from `singleSendEmailId` itself instead of a clone of it. */
  singleSendDirect?: boolean;
  /** Base of the personal link put into the draft. */
  attendeeUrl: string;
  now?: Date;
}

export interface SpikeDeps {
  accessToken: string;
  fetch: typeof fetch;
  log: (line: string) => void;
  /** Waits between status reads; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

export type Outcome = "pass" | "fail" | "skip" | "info";

export interface StepResult {
  id: string;
  question: string;
  outcome: Outcome;
  details: string[];
}

export interface Recording {
  step: string;
  method: string;
  path: string;
  status: number;
  request?: unknown;
  response: unknown;
  /** HubSpot's rate limit headers, when it sends them. */
  rateLimit?: Record<string, string>;
}

export const PLACEHOLDER = "[[em:invitation_link]]";
/** The per-guest part of the link in a single-send email; the token comes with each send. A bare
 * `{{ custom.invitation_link }}` as the whole button URL gave VALIDATION_FAILED (run 8). */
export const SINGLE_SEND_LINK = "{{ custom.invitation_token }}";
/** Single-send endpoints, newest first; the spike records which one answers. */
export const SINGLE_SEND_PATHS = ["/marketing/email-campaigns/2026-09/single-send", "/marketing/v4/email/single-send"];
/** Ways to turn a clone into a single-send email through the API, if HubSpot allows any. */
export const SINGLE_SEND_PATCHES: Record<string, unknown>[] = [{ type: "MARKETING_SINGLE_SEND_API" }, { type: "SINGLE_SEND_API" }, { subcategory: "single_send_api" }];
const MARKETABLE = ["hs_marketable_status", "hs_marketable_reason_type", "hs_marketable_reason_id", "hs_marketable_until_renewal", "hs_legal_basis", "createdate"];
const API = "https://api.hubapi.com";
const REDACTED_EMAIL = "guest@example.com";

class Abort extends Error {}

interface State {
  scopes: string[];
  contactId?: string;
  listId?: string;
  marketingEvent?: { externalAccountId: string; externalEventId: string; objectId?: string };
  cloneId?: string;
  subscriptionId?: string;
  /** The draft goes to our segment and nobody else. */
  draftSafe?: boolean;
  sent?: boolean;
  eventDefinition?: string;
  singleSendId?: string;
  /** We made the single-send email (and may delete it); it was not the one named. */
  singleSendOurs?: boolean;
  /** The single-send recipients: one existing non-marketing contact, one with no contact. */
  recipients?: { which: "existing" | "fresh" | "plain"; email: string; contactId?: string; marketableBefore?: string }[];
  singleSent?: boolean;
  singlePublished?: boolean;
  /** The portal's workflow that set our recipients to marketing, if any (runs 7–14). */
  marketingWorkflowId?: string;
  /** The single-send email's subscription type (the event type) and another one of the portal's. */
  eventType?: string;
  otherType?: string;
  /** Setting a type back to NOT_SPECIFIED works, so the test address may be touched. */
  restoreWorks?: boolean;
  /** Writing needed a legal basis. */
  legalBasis?: boolean;
  otherTypeEmailId?: string;
  /** The single-send endpoint that answered. */
  singleSendPath?: string;
  flowId?: string;
}

interface Response_ {
  status: number;
  ok: boolean;
  body: unknown;
}

export async function runSpike(opts: SpikeOptions, deps: SpikeDeps): Promise<{ results: StepResult[]; recordings: Recording[] }> {
  const now = opts.now ?? new Date();
  const tag = `${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${randomBytes(2).toString("hex")}`;
  const results: StepResult[] = [];
  const recordings: Recording[] = [];
  const state: State = { scopes: [] };
  let current = "";

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const [local, domain] = [opts.email.slice(0, opts.email.lastIndexOf("@")), opts.email.slice(opts.email.lastIndexOf("@") + 1)];
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The tester's address and its plus addresses (the single-send recipients).
  const address = new RegExp(`${esc(local)}(\\+[\\w.-]+)?@${esc(domain)}`, "gi");
  const plus = (which: string) => `${local}+em-${tag}-${which}@${domain}`;
  const redact = (v: unknown): unknown =>
    v === undefined ? undefined : JSON.parse(JSON.stringify(v).split(deps.accessToken).join("«token»").replace(address, (_m, p: string | undefined) => REDACTED_EMAIL.replace("@", `${p ?? ""}@`)));

  async function call(method: string, path: string, body?: unknown): Promise<Response_> {
    const headers: Record<string, string> = { authorization: `Bearer ${deps.accessToken}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let status = 0;
    let parsed: unknown;
    let rateLimit: Record<string, string> | undefined;
    try {
      const res = await deps.fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      status = res.status;
      res.headers?.forEach?.((value, key) => {
        if (/ratelimit/i.test(key)) (rateLimit ??= {})[key] = value;
      });
      const text = await res.text();
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text.slice(0, 2000);
      }
    } catch (e) {
      parsed = { error: e instanceof Error ? e.message : String(e) };
    }
    recordings.push({ step: current, method, path: String(redact(path)), status, request: redact(body), response: redact(parsed), ...(rateLimit ? { rateLimit } : {}) });
    deps.log(`  ${method} ${String(redact(path))} → ${status}`);
    return { status, ok: status >= 200 && status < 300, body: parsed };
  }

  const said = (r: Response_) => {
    const b = r.body as { message?: string; category?: string; errors?: { errorType?: string }[] } | null;
    const types = (b?.errors ?? []).map((e) => e.errorType).filter(Boolean);
    return `${r.status}${b?.category ? ` ${b.category}` : ""}${b?.message ? `: ${b.message}` : ""}${types.length ? ` [${types.join(", ")}]` : ""}`;
  };

  async function step(id: string, question: string, fn: (details: string[]) => Promise<Outcome>) {
    current = id;
    deps.log(`▸ ${id}: ${question}`);
    const details: string[] = [];
    let outcome: Outcome;
    try {
      outcome = await fn(details);
    } catch (e) {
      if (e instanceof Abort) {
        results.push({ id, question, outcome: "fail", details: [...details, e.message] });
        throw e;
      }
      outcome = "fail";
      details.push(`threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    deps.log(`  ${outcome.toUpperCase()}${details.length ? ` – ${details.join("; ")}` : ""}`);
    results.push({ id, question, outcome, details });
  }

  try {
    await step("token", "Which portal and scopes does the token have, and are they the ones the app asks for?", async (d) => {
      const r = await call("GET", `/oauth/v1/access-tokens/${encodeURIComponent(deps.accessToken)}`);
      if (!r.ok) throw new Abort(`could not read the token: ${said(r)}`);
      const info = r.body as { hub_id: number; scopes?: string[]; app_id?: number };
      if (String(info.hub_id) !== opts.portalId) throw new Abort(`the token is for portal ${info.hub_id}, not ${opts.portalId}; nothing was written`);
      state.scopes = info.scopes ?? [];
      const missing = REQUIRED_SCOPES.filter((s) => !state.scopes.includes(s));
      const optional = OPTIONAL_SCOPES.filter((s) => state.scopes.includes(s));
      d.push(`portal ${info.hub_id}, app ${info.app_id ?? "?"}`, missing.length ? `missing required: ${missing.join(", ")}` : "all required scopes granted", `optional granted: ${optional.join(", ") || "none"}`);
      return missing.length ? "fail" : "pass";
    });
  } catch (e) {
    if (e instanceof Abort) return { results, recordings };
    throw e;
  }

  await step("account", "What does the portal say about itself (type, time zone)? Is the Marketing Hub tier visible?", async (d) => {
    const r = await call("GET", "/account-info/v3/details");
    if (!r.ok) return d.push(said(r)), "fail";
    const a = r.body as Record<string, unknown>;
    d.push(`accountType ${String(a.accountType)}, timeZone ${String(a.timeZone)}`, `fields: ${Object.keys(a).join(", ")}`);
    return "info";
  });

  await step("guest-key-property", "Does em_guest_key exist, and can it be read-only in the HubSpot UI?", async (d) => {
    let r = await call("GET", `/crm/v3/properties/contacts/${GUEST_KEY_PROPERTY.name}`);
    if (r.status === 404) {
      d.push("missing: created it (connect through the admin to have the setup job do it)");
      await call("POST", "/crm/v3/properties/contacts/groups", { name: PROPERTY_GROUP.name, label: PROPERTY_GROUP.label });
      await call("POST", "/crm/v3/properties/contacts", { ...GUEST_KEY_PROPERTY, type: "string", fieldType: "text", formField: false });
      r = await call("GET", `/crm/v3/properties/contacts/${GUEST_KEY_PROPERTY.name}`);
    }
    if (!r.ok) return d.push(said(r)), "fail";
    const p = r.body as { modificationMetadata?: Record<string, unknown>; groupName?: string };
    d.push(`group ${p.groupName}`, `modificationMetadata ${JSON.stringify(p.modificationMetadata ?? {})}`);
    // Try to make the value read-only; HubSpot may refuse it for custom properties.
    const ro = await call("PATCH", `/crm/v3/properties/contacts/${GUEST_KEY_PROPERTY.name}`, { modificationMetadata: { readOnlyValue: true } });
    const readOnly = (ro.body as { modificationMetadata?: { readOnlyValue?: boolean } } | null)?.modificationMetadata?.readOnlyValue === true;
    d.push(!ro.ok ? `read-only refused: ${said(ro)}` : readOnly ? "read-only: set" : "read-only: not settable (HubSpot answered OK but readOnlyValue stayed false)");
    return "pass";
  });

  await step("contact", "Can we upsert a contact by email, writing em_guest_key?", async (d) => {
    const r = await call("POST", "/crm/v3/objects/contacts/batch/upsert", {
      inputs: [{ idProperty: "email", id: opts.email, properties: { email: opts.email, [GUEST_KEY_PROPERTY.name]: `spike-${tag}` } }],
    });
    if (!r.ok) return d.push(said(r)), "fail";
    const c = (r.body as { results?: { id: string; properties?: Record<string, string> }[] }).results?.[0];
    state.contactId = c?.id;
    d.push(`contact ${c?.id}, em_guest_key ${c?.properties?.[GUEST_KEY_PROPERTY.name] ?? "(not echoed)"}`);
    return c?.id ? "pass" : "fail";
  });

  await step("segment", "Can we keep a static segment's members in step (create, add, remove, read)?", async (d) => {
    if (!state.contactId) return d.push("no contact"), "skip";
    const r = await call("POST", "/crm/v3/lists", { name: `EM spike · ${tag}`, objectTypeId: "0-1", processingType: "MANUAL" });
    if (!r.ok) return d.push(`create: ${said(r)}`), "fail";
    state.listId = String((r.body as { list?: { listId?: string | number } }).list?.listId ?? "");
    if (!state.listId) return d.push("no listId in the answer"), "fail";
    const members = async () => ((await call("GET", `/crm/v3/lists/${state.listId}/memberships`)).body as { results?: { recordId: string }[] } | null)?.results?.map((m) => String(m.recordId)) ?? [];
    const add = await call("PUT", `/crm/v3/lists/${state.listId}/memberships/add`, [state.contactId]);
    const afterAdd = await members();
    const remove = await call("PUT", `/crm/v3/lists/${state.listId}/memberships/remove`, [state.contactId]);
    const afterRemove = await members();
    await call("PUT", `/crm/v3/lists/${state.listId}/memberships/add`, [state.contactId]);
    const ok = add.ok && remove.ok && afterAdd.includes(state.contactId) && !afterRemove.includes(state.contactId);
    d.push(`list ${state.listId}`, `add ${add.status} → member ${afterAdd.includes(state.contactId)}`, `remove ${remove.status} → member ${afterRemove.includes(state.contactId)}`, "batch limits: see HubSpot's answer headers in the recording");
    return ok ? "pass" : "fail";
  });

  await step("marketing-event", "Can we create a marketing event and record attendance by email?", async (d) => {
    const externalAccountId = "em-spike";
    const externalEventId = `spike-${tag}`;
    const start = new Date(now.getTime() + 14 * 86_400_000);
    const r = await call("POST", "/marketing/v3/marketing-events/events", {
      externalAccountId, externalEventId, eventName: `EM spike ${tag}`, eventOrganizer: "Event manager spike", eventType: "In person",
      startDateTime: start.toISOString(), endDateTime: new Date(start.getTime() + 2 * 3_600_000).toISOString(), eventUrl: `${opts.attendeeUrl}/spike`,
    });
    if (!r.ok) return d.push(`create: ${said(r)}`), "fail";
    state.marketingEvent = { externalAccountId, externalEventId, objectId: (r.body as { objectId?: string } | null)?.objectId };
    const outcomes: string[] = [];
    let ok = true;
    for (const subscriberState of ["register", "attend"]) {
      const a = await call("POST", `/marketing/v3/marketing-events/attendance/${externalEventId}/${subscriberState}/email-create?externalAccountId=${externalAccountId}`, {
        inputs: [{ email: opts.email, interactionDateTime: now.getTime() }],
      });
      ok &&= a.ok;
      outcomes.push(`${subscriberState} ${a.ok ? a.status : said(a)}`);
    }
    const b = await call("GET", `/marketing/v3/marketing-events/participations/${externalAccountId}/${externalEventId}/breakdown`);
    d.push(...outcomes, `breakdown ${b.ok ? JSON.stringify(b.body).slice(0, 300) : said(b)}`);
    return ok ? "pass" : "fail";
  });

  await step("marketing-event-attendance", "Does the attendance we recorded show up in HubSpot later, and through which read?", async (d) => {
    const me = state.marketingEvent;
    if (!me) return d.push("no marketing event"), "skip";
    // Runs 1–6 read total 0 straight after register and attend. Read every way HubSpot offers,
    // for up to `attendanceWaitMs`, and stop at the first that shows the contact.
    const reads: [string, string][] = [
      ["by external ids", `/marketing/v3/marketing-events/participations/${me.externalAccountId}/${me.externalEventId}/breakdown`],
      ...(me.objectId ? ([["by object id", `/marketing/v3/marketing-events/participations/${me.objectId}/breakdown`]] as [string, string][]) : []),
      ["by contact", `/marketing/v3/marketing-events/participations/contacts/${encodeURIComponent(opts.email)}/breakdown`],
      ["event counters", `/marketing/v3/marketing-events/events/${me.externalEventId}?externalAccountId=${me.externalAccountId}`],
    ];
    const shows = (body: unknown) => {
      const b = body as { total?: number; results?: unknown[] } & Record<string, unknown> | null;
      if (!b) return false;
      if ((b.total ?? 0) > 0 || (b.results?.length ?? 0) > 0) return true;
      return ["registrants", "attendees", "noShows", "cancellations"].some((k) => typeof b[k] === "number" && (b[k] as number) > 0);
    };
    const wait = opts.attendanceWaitMs ?? 300_000;
    const started = Date.now();
    let round = 0;
    for (;;) {
      round++;
      const seen: string[] = [];
      let summary = "";
      for (const [label, path] of reads) {
        const r = await call("GET", path);
        if (r.ok && shows(r.body)) seen.push(label);
        if (round === 1 || seen.includes(label)) summary += `${label}: ${r.ok ? JSON.stringify(r.body).slice(0, 220) : said(r)}; `;
      }
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (seen.length) return d.push(`after ${elapsed}s (round ${round}) attendance shows ${seen.join(", ")}`, summary), "pass";
      if (round === 1) d.push(`first read: ${summary}`);
      if (Date.now() - started >= wait) return d.push(`nothing after ${elapsed}s (${round} rounds)`), "fail";
      await sleep(30_000);
    }
  });

  await step("subscription-types", "Can we list the portal's subscription types, to set one on each draft?", async (d) => {
    const r = await call("GET", "/communication-preferences/v3/definitions");
    const wanted = opts.subscription?.trim().toLowerCase();
    if (!r.ok) {
      d.push(`list: ${said(r)}`);
      if (opts.subscription && /^\d+$/.test(opts.subscription)) {
        state.subscriptionId = opts.subscription;
        d.push(`using id ${opts.subscription} as given`);
      }
      return "fail";
    }
    const defs = (r.body as { subscriptionDefinitions?: { id: string | number; name: string; isActive?: boolean }[] } | null)?.subscriptionDefinitions ?? [];
    d.push(`types: ${defs.map((s) => `${s.id} "${s.name}"${s.isActive === false ? " (inactive)" : ""}`).join("; ") || "none"}`);
    if (wanted) {
      const hit = defs.find((s) => String(s.id) === wanted || s.name.trim().toLowerCase() === wanted);
      state.subscriptionId = hit ? String(hit.id) : undefined;
      d.push(hit ? `using ${hit.id} "${hit.name}"` : `no subscription type matches "${opts.subscription}"`);
      if (!hit) return "fail";
    }
    return "pass";
  });

  await step("email-clone", `Can we clone a template email, and does its content carry ${PLACEHOLDER}?`, async (d) => {
    if (!opts.templateEmailId) {
      const l = await call("GET", "/marketing/v3/emails?limit=20");
      const items = ((l.body as { results?: { id: string; name: string; type?: string }[] } | null)?.results ?? []).map((e) => `${e.id} "${e.name}" (${e.type ?? "?"})`);
      d.push("pass --template-email <id> to clone one", `emails: ${items.join("; ") || (l.ok ? "none" : said(l))}`);
      return "skip";
    }
    const r = await call("POST", "/marketing/v3/emails/clone", { id: opts.templateEmailId, cloneName: `EM spike · ${tag} · Invitation` });
    if (!r.ok) return d.push(`clone: ${said(r)}`), "fail";
    state.cloneId = String((r.body as { id: string }).id);
    const g = await call("GET", `/marketing/v3/emails/${state.cloneId}`);
    const e = g.body as { type?: string; emailTemplateMode?: string; content?: unknown; subscriptionDetails?: { subscriptionId?: string | number } } | null;
    const has = JSON.stringify(e?.content ?? {}).includes(PLACEHOLDER);
    const kept = e?.subscriptionDetails?.subscriptionId;
    d.push(`clone ${state.cloneId}, type ${e?.type}, mode ${e?.emailTemplateMode ?? "?"}`, has ? "placeholder found in content" : "placeholder NOT found in content", kept ? `subscription type kept: ${kept}` : "no subscription type on the clone");
    return has ? "pass" : "fail";
  });

  await step("email-draft", "Can we set name, subject, preview text, recipients (our segment) and replace the placeholder with the personal link?", async (d) => {
    if (!state.cloneId) return d.push("no clone"), "skip";
    const g = await call("GET", `/marketing/v3/emails/${state.cloneId}`);
    const content = (g.body as { content?: unknown } | null)?.content ?? {};
    const link = `${opts.attendeeUrl}/h/spike-event/{{ contact.${GUEST_KEY_PROPERTY.name} }}`;
    const replaced = JSON.parse(JSON.stringify(content).split(PLACEHOLDER).join(link.replace(/"/g, '\\"'))) as { widgets?: Record<string, { body?: { value?: string } }> };
    // Preview text is a module in drag-and-drop emails (run 1), not a top-level field.
    const previewText = `Preview ${tag}`;
    const previewWidget = replaced.widgets?.preview_text;
    if (previewWidget) previewWidget.body = { ...previewWidget.body, value: previewText };
    const subject = `EM spike ${tag}`;
    // Replace every kind of recipient: a clone keeps the template's own lists (run 1), which
    // would otherwise get the email too.
    const none = { include: [], exclude: [] };
    const existing = (g.body as { subscriptionDetails?: Record<string, unknown> } | null)?.subscriptionDetails ?? {};
    const patch = await call("PATCH", `/marketing/v3/emails/${state.cloneId}`, {
      name: `EM spike · ${tag} · Invitation`, subject, content: replaced,
      ...(state.subscriptionId ? { subscriptionDetails: { ...existing, subscriptionId: state.subscriptionId } } : {}),
      to: { contactIlsLists: state.listId ? { include: [state.listId], exclude: [] } : none, contactLists: none, contactIds: none },
    });
    type To = Record<string, { include?: (string | number)[] } | boolean | undefined>;
    const after = (await call("GET", `/marketing/v3/emails/${state.cloneId}`)).body as { subject?: string; to?: To; content?: unknown; subscriptionDetails?: { subscriptionId?: string | number } } | null;
    const text = JSON.stringify(after ?? {});
    const recipients = Object.entries(after?.to ?? {}).flatMap(([k, v]) => (typeof v === "object" && v ? (v.include ?? []).map((id) => `${k}:${id}`) : []));
    // HubSpot also lists a segment under its legacy id in contactLists (run 3). Resolve those, so
    // our own segment counts as ours and anything else does not.
    const legacy = new Map<string, string>();
    for (const r of recipients.filter((x) => x.startsWith("contactLists:"))) {
      const id = r.slice("contactLists:".length);
      const m = await call("GET", `/crm/v3/lists/idmapping?legacyListId=${encodeURIComponent(id)}`);
      const listId = (m.body as { listId?: string | number } | null)?.listId;
      if (m.ok && listId !== undefined) legacy.set(r, `contactIlsLists:${listId}`);
    }
    const resolved = [...new Set(recipients.map((r) => legacy.get(r) ?? r))];
    const checks = {
      patched: patch.ok,
      subject: after?.subject === subject,
      onlyOurSegment: state.listId ? resolved.length === 1 && resolved[0] === `contactIlsLists:${state.listId}` : resolved.length === 0,
      link: text.includes(`contact.${GUEST_KEY_PROPERTY.name}`),
      placeholderGone: !text.includes(PLACEHOLDER),
      previewText: text.includes(previewText),
      subscription: !state.subscriptionId || String(after?.subscriptionDetails?.subscriptionId ?? "") === state.subscriptionId,
    };
    d.push(...Object.entries(checks).map(([k, v]) => `${k} ${v ? "✓" : "✗"}`), `recipients ${recipients.map((r) => (legacy.has(r) ? `${r} (= ${legacy.get(r)})` : r)).join(", ") || "none"}`, patch.ok ? "" : `patch: ${said(patch)}`, previewWidget ? "" : "no preview_text module in the content");
    d.splice(0, d.length, ...d.filter(Boolean));
    state.draftSafe = checks.patched && checks.onlyOurSegment && !!state.listId;
    return Object.values(checks).every(Boolean) ? "pass" : "fail";
  });

  await step("email-send", "Can we publish (send) the draft through the API, and what does HubSpot say when the plan does not allow it?", async (d) => {
    if (!state.cloneId) return d.push("no draft"), "skip";
    if (!opts.send) return d.push(`pass --send to publish: it sends a real email to the test inbox`), "skip";
    if (!state.draftSafe) return d.push("not published: the draft's recipients are not only our segment (see email-draft)"), "skip";
    const r = await call("POST", `/marketing/v3/emails/${state.cloneId}/publish`);
    state.sent = r.ok;
    const after = (await call("GET", `/marketing/v3/emails/${state.cloneId}`)).body as { state?: string; publishDate?: string } | null;
    d.push(r.ok ? `published (${r.status})` : `refused: ${said(r)} – the error a non-Enterprise portal gives is our capability check`, `state ${after?.state}, publishDate ${after?.publishDate ?? "-"}`, "check the inbox: does the link open /h/spike-event/<the contact's key>?");
    return r.ok ? "pass" : "fail";
  });

  await step("single-send-email", "Can the platform make a single-send email from the template through the API, or must it be set up in HubSpot? How does the API show one?", async (d) => {
    // How the portal's emails are typed, so a template picker knows what to look for.
    const l = await call("GET", "/marketing/v3/emails?limit=100");
    const all = (l.body as { results?: { id: string; name: string; type?: string; subcategory?: string; state?: string }[] } | null)?.results ?? [];
    const kinds = new Map<string, number>();
    for (const e of all) kinds.set(`${e.type ?? "?"}/${e.subcategory ?? "?"}`, (kinds.get(`${e.type ?? "?"}/${e.subcategory ?? "?"}`) ?? 0) + 1);
    d.push(`portal emails by type/subcategory: ${[...kinds].map(([k, n]) => `${k} ×${n}`).join(", ") || (l.ok ? "none" : said(l))}`);
    const describe = async (id: string) => {
      const e = (await call("GET", `/marketing/v3/emails/${id}`)).body as { type?: string; subcategory?: string; state?: string; emailTemplateMode?: string; content?: unknown } | null;
      const text = JSON.stringify(e?.content ?? {});
      return { type: e?.type, subcategory: e?.subcategory, line: `type ${e?.type}, subcategory ${e?.subcategory ?? "-"}, state ${e?.state}, mode ${e?.emailTemplateMode ?? "?"}`, hasLink: text.includes("custom.invitation_token"), hasPlaceholder: text.includes(PLACEHOLDER), content: e?.content };
    };
    if (opts.singleSendEmailId) {
      state.singleSendId = opts.singleSendEmailId;
      const e = await describe(opts.singleSendEmailId);
      d.push(`named email ${opts.singleSendEmailId}: ${e.line}`);
      if (opts.singleSendDirect) {
        // Send from the named email as it is, to tell a problem with our clone from one with the email.
        d.push(`sending from the named email itself (--single-send-direct)${e.hasLink ? "" : ": its link is not personalised"}`);
        return "info";
      }
      if (!e.hasLink && e.hasPlaceholder) {
        // The client's template with our placeholder: leave it alone and work on a clone, which also
        // shows whether a clone stays a single-send email (so the platform could make one per event).
        const r = await call("POST", "/marketing/v3/emails/clone", { id: opts.singleSendEmailId, cloneName: `EM spike · ${tag} · Single-send` });
        if (!r.ok) return d.push(`clone: ${said(r)}`), "fail";
        state.singleSendId = String((r.body as { id: string }).id);
        state.singleSendOurs = true;
        const c = await describe(state.singleSendId);
        const kept = c.type === e.type && c.subcategory === e.subcategory;
        d.push(`clone ${state.singleSendId}: ${c.line}${kept ? " (kept the single-send type)" : " (type NOT kept)"}`);
        const content = JSON.parse(JSON.stringify(c.content ?? {}).split(PLACEHOLDER).join(`${opts.attendeeUrl}/i/${SINGLE_SEND_LINK}`));
        const p = await call("PATCH", `/marketing/v3/emails/${state.singleSendId}`, { content, subject: `EM spike ${tag} (single-send)` });
        d.push(p.ok ? `placeholder replaced with ${SINGLE_SEND_LINK} in the clone` : `could not replace the placeholder: ${said(p)}`);
        return p.ok && kept ? "pass" : "fail";
      }
      d.push(e.hasLink ? `${SINGLE_SEND_LINK} found in content` : `neither ${SINGLE_SEND_LINK} nor ${PLACEHOLDER} in content: the sent email will have no personal link`);
      return e.hasLink ? "pass" : "fail";
    }
    if (!opts.templateEmailId) return d.push("pass --single-send-email <id> or --template-email <id>"), "skip";
    const r = await call("POST", "/marketing/v3/emails/clone", { id: opts.templateEmailId, cloneName: `EM spike · ${tag} · Single-send` });
    if (!r.ok) return d.push(`clone: ${said(r)}`), "fail";
    state.singleSendId = String((r.body as { id: string }).id);
    state.singleSendOurs = true;
    const before = await describe(state.singleSendId);
    d.push(`clone ${state.singleSendId}: ${before.line}`);
    const content = JSON.parse(JSON.stringify(before.content ?? {}).split(PLACEHOLDER).join(`${opts.attendeeUrl}/i/${SINGLE_SEND_LINK}`));
    const c = await call("PATCH", `/marketing/v3/emails/${state.singleSendId}`, { content, subject: `EM spike ${tag} (single-send)` });
    d.push(c.ok ? `placeholder replaced with ${SINGLE_SEND_LINK}` : `content: ${said(c)}`);
    let made = false;
    for (const patch of SINGLE_SEND_PATCHES) {
      const p = await call("PATCH", `/marketing/v3/emails/${state.singleSendId}`, patch);
      const after = await describe(state.singleSendId);
      const changed = after.type !== before.type || after.subcategory !== before.subcategory;
      d.push(`PATCH ${JSON.stringify(patch)} → ${p.ok ? p.status : said(p)}; now ${after.line}${changed ? " (changed)" : ""}`);
      if (changed) {
        made = true;
        break;
      }
    }
    if (!made) d.push("the API did not change the email's type: a single-send email has to be made in HubSpot (Save for single-send API); the send step shows what HubSpot says about this clone");
    return made ? "pass" : "fail";
  });

  await step("single-send-contacts", "Recipients for single-send: an existing non-marketing contact, and an address with no contact", async (d) => {
    const props = (c: { properties?: Record<string, string | null> } | undefined) => MARKETABLE.map((p) => `${p}=${c?.properties?.[p] ?? "∅"}`).join(", ");
    const existing = plus("existing");
    const fresh = plus("fresh");
    const u = await call("POST", "/crm/v3/objects/contacts/batch/upsert", { inputs: [{ idProperty: "email", id: existing, properties: { email: existing, firstname: "EM spike" } }] });
    const first = (u.body as { results?: { id: string; new?: boolean }[] } | null)?.results?.[0];
    const id = first?.id;
    if (!u.ok || !id) return d.push(`upsert: ${said(u)}`), "fail";
    // Cleanup needs to know whether the platform created a contact (docs/hubspot.md, "Cleanup").
    d.push(`upsert says new: ${first?.new === undefined ? "(no new flag)" : String(first.new)}`);
    const read = (await call("GET", `/crm/v3/objects/contacts/${id}?properties=${MARKETABLE.join(",")}`)).body as { properties?: Record<string, string | null> } | undefined;
    const none = await call("POST", "/crm/v3/objects/contacts/search", { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: fresh }] }], properties: ["email"] });
    const freshFound = ((none.body as { total?: number } | null)?.total ?? 0) > 0;
    state.recipients = [
      { which: "existing", email: existing, contactId: id, marketableBefore: read?.properties?.hs_marketable_status ?? undefined },
      { which: "fresh", email: fresh },
      // The test address itself, a marketing contact that a regular email reached in run 6: tells a
      // problem with plus addresses from one with the send (runs 7–11 failed validation for both).
      { which: "plain", email: opts.email, contactId: state.contactId },
    ];
    d.push(`existing: contact ${id}, ${props(read)}`, freshFound ? "fresh: a contact already exists (unexpected)" : "fresh: no contact, as intended");
    return read?.properties?.hs_marketable_status === "true" || freshFound ? "fail" : "pass";
  });

  await step("single-send", "Does the single-send API send to each recipient with its own link, ignore a repeated sendId, and report a result per send?", async (d) => {
    if (!state.singleSendId || !state.recipients) return d.push("no single-send email or recipients"), "skip";
    if (!opts.send) return d.push(`pass --send to send: it sends two real emails to plus addresses of the test inbox`), "skip";
    let path: string | undefined;
    const send = async (r: { which: string; email: string }, sendId: string) => {
      const customProperties = { invitation_token: `spike-${r.which}-${tag}`, event_title: `EM spike ${tag}`, event_date: now.toISOString().slice(0, 10) };
      // Two shapes, to see which HubSpot takes (run 7 had VALIDATION_FAILED with the first for
      // both): the OpenAPI's, with every field it marks required, and the guide's minimal one.
      const body = r.which === "existing"
        ? { emailId: Number(state.singleSendId), message: { to: r.email, sendId, cc: [], bcc: [], replyTo: [] }, contactProperties: {}, customProperties }
        : { emailId: Number(state.singleSendId), message: { to: r.email, sendId }, customProperties };
      // Newest endpoint first; fall back on 404 and remember the one that answered.
      const paths = path ? [path] : SINGLE_SEND_PATHS;
      let res: Response_ | undefined;
      for (const p of paths) {
        res = await call("POST", p, body);
        if (res.status === 404 && p !== paths.at(-1)) {
          d.push(`${p} → 404`);
          continue;
        }
        if (res.status !== 404) path = p;
        break;
      }
      return res!;
    };
    type Status = { statusId?: string; status?: string; sendResult?: string };
    const sent: { which: string; statusId?: string; first: Status }[] = [];
    for (const r of state.recipients) {
      let res = await send(r, `em-spike-${tag}-${r.which}`);
      // HubSpot refuses a draft (run 7), although its guide says a draft will do. Publishing a
      // single-send email sends nothing by itself; do it on our own clone only, then try again.
      if (res.status === 400 && /draft state/i.test(said(res)) && state.singleSendOurs && !state.singlePublished) {
        d.push(`${r.which}: ${said(res)}`);
        const p = await call("POST", `/marketing/v3/emails/${state.singleSendId}/publish`);
        const after = (await call("GET", `/marketing/v3/emails/${state.singleSendId}`)).body as { state?: string } | null;
        state.singlePublished = p.ok;
        d.push(`published the clone: ${p.ok ? p.status : said(p)}, state ${after?.state}`);
        // HubSpot may take a while to see the publish (run 7); then try the older endpoint too.
        for (let i = 0; p.ok && i < 6; i++) {
          await sleep(10_000);
          res = await send(r, `em-spike-${tag}-${r.which}`);
          if (!(res.status === 400 && /draft state/i.test(said(res)))) break;
        }
        if (res.status === 400 && /draft state/i.test(said(res)) && path !== SINGLE_SEND_PATHS.at(-1)) {
          d.push(`still a draft to ${path} after a minute: trying ${SINGLE_SEND_PATHS.at(-1)}`);
          path = SINGLE_SEND_PATHS.at(-1);
          res = await send(r, `em-spike-${tag}-${r.which}`);
        }
      }
      const b = (res.body ?? {}) as Status;
      d.push(`${r.which}: ${res.ok ? `${res.status} status ${b.status}, sendResult ${b.sendResult ?? "-"}, statusId ${b.statusId}` : said(res)}`);
      sent.push({ which: r.which, statusId: b.statusId, first: b });
    }
    if (path) d.push(`endpoint ${path}`);
    state.singleSendPath = path;
    state.singleSent = sent.some((s) => s.statusId);
    if (!state.singleSent) return "fail";
    // The same sendId again: HubSpot should not send twice.
    // On the plain address, the one HubSpot delivers to (plus addresses fail validation, run 12).
    const repeat = state.recipients.at(-1)!;
    const first = sent.find((x) => x.which === repeat.which);
    const again = await send(repeat, `em-spike-${tag}-${repeat.which}`);
    const ab = (again.body ?? {}) as Status;
    if (ab.statusId && ab.statusId !== first?.statusId) sent.push({ which: "repeat", statusId: ab.statusId, first: ab });
    d.push(`same sendId again: ${again.ok ? `${again.status} status ${ab.status}, sendResult ${ab.sendResult ?? "-"}, statusId ${ab.statusId}${ab.statusId === first?.statusId ? " (same statusId)" : ""}` : said(again)}`);
    // Each send's own result, once HubSpot has processed it.
    for (const s of sent.filter((x) => x.statusId)) {
      let st: Status = s.first;
      for (let i = 0; i < 12 && st.status !== "COMPLETE" && st.status !== "CANCELED"; i++) {
        await sleep(5_000);
        st = ((await call("GET", `/marketing/v3/email/send-statuses/${s.statusId}`)).body ?? {}) as Status;
      }
      d.push(`${s.which} status: ${st.status}, sendResult ${st.sendResult ?? "-"}`);
    }
    d.push("check the inboxes: does each button open /i/spike-<which>-<tag>?");
    return "pass";
  });

  await step("single-send-marketing", "Did single-send make both recipients marketing contacts, as HubSpot warns?", async (d) => {
    if (!state.singleSent || !state.recipients) return d.push("nothing sent"), "skip";
    let ok = true;
    for (const r of state.recipients) {
      let props: Record<string, string | null> | undefined;
      // Contact creation and the marketing flag may lag the send.
      for (let i = 0; i < 6; i++) {
        const s = await call("POST", "/crm/v3/objects/contacts/search", { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: r.email }] }], properties: MARKETABLE });
        const c = (s.body as { results?: { id: string; properties?: Record<string, string | null> }[] } | null)?.results?.[0];
        if (c) {
          r.contactId = c.id;
          props = c.properties;
        }
        if (props?.hs_marketable_status === "true") break;
        await sleep(10_000);
      }
      ok &&= props?.hs_marketable_status === "true";
      if (props?.hs_marketable_reason_type === "WORKFLOW" && props.hs_marketable_reason_id) state.marketingWorkflowId = props.hs_marketable_reason_id;
      d.push(`${r.which}: ${r.contactId ? `contact ${r.contactId}` : "no contact"}, marketable ${r.marketableBefore ?? "∅"} → ${props?.hs_marketable_status ?? "∅"}; ${MARKETABLE.slice(1).map((p) => `${p}=${props?.[p] ?? "∅"}`).join(", ")}`);
    }
    return ok ? "pass" : "info";
  });

  // Cleanup after HubSpot sending (docs/hubspot.md): subscription types, marketing status and the
  // workflow that sets contacts back to non-marketing. Subscription status belongs to the email
  // address and outlives the contact, so everything is tried on the throwaway plus address first,
  // and the test address is only touched once setting a status back is shown to work.
  const LEGAL = { legalBasis: "LEGITIMATE_INTEREST_OTHER", legalBasisExplanation: "Event manager spike: temporary contact for an event invitation; not for other marketing" };
  const cleanupMissing = () => CLEANUP_SCOPES.filter((sc) => !state.scopes.includes(sc));
  type SubStatus = { subscriptionId?: string | number; status?: string; source?: string; legalBasis?: string };
  const statuses = async (email: string) => {
    const r = await call("GET", `/communication-preferences/v4/statuses/${encodeURIComponent(email)}?channel=EMAIL`);
    const found = new Map<string, SubStatus>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        const o = v as SubStatus & Record<string, unknown>;
        if (o.subscriptionId !== undefined && typeof o.status === "string") found.set(String(o.subscriptionId), o);
        else Object.values(o).forEach(walk);
      }
    };
    walk(r.body);
    return { r, found };
  };
  const setStatus = async (email: string, subscriptionId: string, statusState: string) => {
    const base = { subscriptionId: Number(subscriptionId), statusState, channel: "EMAIL" };
    let r = await call("POST", `/communication-preferences/v4/statuses/${encodeURIComponent(email)}`, state.legalBasis ? { ...base, ...LEGAL } : base);
    if (!r.ok && !state.legalBasis && /legal/i.test(said(r))) {
      state.legalBasis = true;
      r = await call("POST", `/communication-preferences/v4/statuses/${encodeURIComponent(email)}`, { ...base, ...LEGAL });
    }
    return r;
  };

  await step("subscription-types-v4", "Which subscription types does the portal have, and which one does the single-send email use?", async (d) => {
    const missing = cleanupMissing();
    if (missing.length) return d.push(`not granted: ${missing.join(", ")} (upload the app and reconnect)`), "skip";
    const r = await call("GET", "/communication-preferences/v4/definitions");
    if (!r.ok) return d.push(`definitions: ${said(r)}`), "fail";
    const defs = ((r.body as { results?: { id: string | number; name: string; isActive?: boolean }[] } | null)?.results ?? []).map((x) => ({ ...x, id: String(x.id) }));
    if (state.singleSendId) {
      const e = (await call("GET", `/marketing/v3/emails/${state.singleSendId}`)).body as { subscriptionDetails?: { subscriptionId?: string | number } } | null;
      state.eventType = e?.subscriptionDetails?.subscriptionId === undefined ? undefined : String(e.subscriptionDetails.subscriptionId);
    }
    state.otherType = defs.find((x) => x.id !== state.eventType && x.isActive !== false)?.id;
    d.push(`types: ${defs.map((x) => `${x.id} "${x.name}"${x.isActive === false ? " (inactive)" : ""}`).join("; ") || "none"}`, `event type (the single-send email's): ${state.eventType ?? "none"}`, `other type for the checks: ${state.otherType ?? "none"}`);
    return state.eventType && state.otherType ? "pass" : "fail";
  });

  await step("subscription-write", "On a throwaway address: can the platform unsubscribe from one type and set it back to NOT_SPECIFIED, and does that need a legal basis?", async (d) => {
    const target = state.recipients?.find((r) => r.which === "existing");
    if (!state.otherType || !target) return d.push("no other type or no throwaway contact"), "skip";
    const before = await statuses(target.email);
    d.push(`read ${before.r.ok ? before.r.status : said(before.r)}: ${state.otherType} ${before.found.get(state.otherType)?.status ?? "(not listed)"}`);
    const u = await setStatus(target.email, state.otherType, "UNSUBSCRIBED");
    const afterU = await statuses(target.email);
    d.push(`UNSUBSCRIBED: ${u.ok ? u.status : said(u)}${state.legalBasis ? " (needed a legal basis)" : " (no legal basis needed)"} → ${afterU.found.get(state.otherType)?.status ?? "?"}`);
    const n = await setStatus(target.email, state.otherType, "NOT_SPECIFIED");
    const afterN = await statuses(target.email);
    const back = afterN.found.get(state.otherType)?.status;
    d.push(`NOT_SPECIFIED: ${n.ok ? n.status : said(n)} → ${back ?? "?"}`);
    state.restoreWorks = n.ok && back === "NOT_SPECIFIED";
    // The batch endpoint, which the cleanup job would use.
    const b = await call("POST", "/communication-preferences/v4/statuses/batch/write", { inputs: [{ subscriberIdString: target.email, subscriptionId: Number(state.otherType), statusState: "UNSUBSCRIBED", channel: "EMAIL", ...(state.legalBasis ? LEGAL : {}) }] });
    d.push(`batch write UNSUBSCRIBED: ${b.ok ? b.status : said(b)}`);
    return u.ok && afterU.found.get(state.otherType)?.status === "UNSUBSCRIBED" && state.restoreWorks ? "pass" : "fail";
  });

  await step("subscription-blocks", "With the test address unsubscribed from another type: is an email of that type blocked, and one of the event type still sent?", async (d) => {
    if (!opts.send) return d.push("pass --send: it sends up to two emails to the test inbox"), "skip";
    if (!state.restoreWorks) return d.push("not run: setting a type back to NOT_SPECIFIED did not work, so the test address is not touched"), "skip";
    if (!state.otherType || !state.singleSendId || !state.singlePublished) return d.push("needs a published single-send clone and another type"), "skip";
    const before = (await statuses(opts.email)).found.get(state.otherType)?.status ?? "NOT_SPECIFIED";
    const u = await setStatus(opts.email, state.otherType, "UNSUBSCRIBED");
    d.push(`test address: ${state.otherType} ${before} → UNSUBSCRIBED (${u.ok ? u.status : said(u)})`);
    // A copy of our single-send email with the other type, standing in for a client's newsletter.
    const c = await call("POST", "/marketing/v3/emails/clone", { id: state.singleSendId, cloneName: `EM spike · ${tag} · Other type` });
    state.otherTypeEmailId = c.ok ? String((c.body as { id: string }).id) : undefined;
    if (state.otherTypeEmailId) {
      const e = (await call("GET", `/marketing/v3/emails/${state.otherTypeEmailId}`)).body as { subscriptionDetails?: Record<string, unknown> } | null;
      const p = await call("PATCH", `/marketing/v3/emails/${state.otherTypeEmailId}`, { subscriptionDetails: { ...(e?.subscriptionDetails ?? {}), subscriptionId: state.otherType }, subject: `EM spike ${tag} (other type: should not arrive)` });
      const pub = await call("POST", `/marketing/v3/emails/${state.otherTypeEmailId}/publish`);
      d.push(`other-type email ${state.otherTypeEmailId}: patch ${p.ok ? p.status : said(p)}, publish ${pub.ok ? pub.status : said(pub)}`);
    }
    const result = async (emailId: string, label: string) => {
      let r: Response_ | undefined;
      for (let i = 0; i < 7; i++) {
        r = await call("POST", state.singleSendPath ?? SINGLE_SEND_PATHS[0]!, { emailId: Number(emailId), message: { to: opts.email, sendId: `em-spike-${tag}-${label}` }, customProperties: { invitation_token: `spike-${label}-${tag}` } });
        if (!(r.status === 400 && /draft state/i.test(said(r)))) break;
        await sleep(10_000);
      }
      let st = (r!.body ?? {}) as { statusId?: string; status?: string; sendResult?: string };
      for (let i = 0; st.statusId && i < 12 && st.status !== "COMPLETE"; i++) {
        await sleep(5_000);
        st = ((await call("GET", `/marketing/v3/email/send-statuses/${st.statusId}`)).body ?? {}) as typeof st;
      }
      d.push(`${label}: ${r!.ok ? `${st.status}, sendResult ${st.sendResult ?? "-"}` : said(r!)}`);
      return st.sendResult;
    };
    const own = await result(state.singleSendId, "event-type");
    const other = state.otherTypeEmailId ? await result(state.otherTypeEmailId, "other-type") : undefined;
    // Put the test address back as it was.
    const restore = await setStatus(opts.email, state.otherType, before === "SUBSCRIBED" ? "SUBSCRIBED" : "NOT_SPECIFIED");
    const now_ = (await statuses(opts.email)).found.get(state.otherType)?.status;
    d.push(`test address restored to ${now_ ?? "?"} (${restore.ok ? restore.status : said(restore)})`);
    return own === "SENT" && other !== undefined && other !== "SENT" && now_ === before ? "pass" : "fail";
  });

  await step("unsubscribe-all", "On a throwaway address: does unsubscribe-all also stop a single-send of the event type?", async (d) => {
    const target = state.recipients?.find((r) => r.which === "existing");
    if (cleanupMissing().length || !target) return d.push("no scopes or no throwaway contact"), "skip";
    const u = await call("POST", "/communication-preferences/v4/statuses/batch/unsubscribe-all?channel=EMAIL", { inputs: [target.email] });
    d.push(`unsubscribe-all: ${u.ok ? u.status : said(u)}`);
    if (!opts.send || !state.singleSendId || !state.singlePublished) return d.push("no send (needs --send and a published clone)"), "info";
    const r = await call("POST", state.singleSendPath ?? SINGLE_SEND_PATHS[0]!, { emailId: Number(state.singleSendId), message: { to: target.email, sendId: `em-spike-${tag}-unsub-all` }, customProperties: { invitation_token: "x" } });
    let st = (r.body ?? {}) as { statusId?: string; status?: string; sendResult?: string };
    for (let i = 0; st.statusId && i < 12 && st.status !== "COMPLETE"; i++) {
      await sleep(5_000);
      st = ((await call("GET", `/marketing/v3/email/send-statuses/${st.statusId}`)).body ?? {}) as typeof st;
    }
    d.push(`single-send after unsubscribe-all: ${r.ok ? `${st.status}, sendResult ${st.sendResult ?? "-"}` : said(r)}`, "plus addresses fail validation anyway (run 12), so only a PREVIOUSLY_UNSUBSCRIBED_* result is conclusive");
    return "info";
  });

  await step("marketable-write", "Can the API set a contact back to non-marketing?", async (d) => {
    const target = state.recipients?.find((r) => r.which === "existing");
    if (!target?.contactId) return d.push("no throwaway contact"), "skip";
    const was = ((await call("GET", `/crm/v3/objects/contacts/${target.contactId}?properties=hs_marketable_status`)).body as { properties?: Record<string, string | null> } | null)?.properties?.hs_marketable_status;
    if (was !== "true") return d.push(`the contact is not a marketing contact (${was ?? "∅"}), so nothing to set back; run with --send`), "skip";
    const r = await call("PATCH", `/crm/v3/objects/contacts/${target.contactId}`, { properties: { hs_marketable_status: "false" } });
    const after = (await call("GET", `/crm/v3/objects/contacts/${target.contactId}?properties=hs_marketable_status,hs_marketable_until_renewal`)).body as { properties?: Record<string, string | null> } | null;
    // HubSpot may answer 200 and ignore it (run 15), so only the value read back counts.
    const changed = after?.properties?.hs_marketable_status === "false" || after?.properties?.hs_marketable_until_renewal === "true";
    d.push(`PATCH hs_marketable_status=false: ${r.ok ? r.status : said(r)}`, `now hs_marketable_status=${after?.properties?.hs_marketable_status ?? "∅"}, hs_marketable_until_renewal=${after?.properties?.hs_marketable_until_renewal ?? "∅"}`, changed ? "the API changed it" : "unchanged: the API cannot set non-marketing");
    return changed ? "pass" : "fail";
  });

  await step("workflow", "Can the platform create a workflow, enrolled on our segment, that sets contacts to non-marketing?", async (d) => {
    if (cleanupMissing().length) return d.push(`not granted: ${cleanupMissing().join(", ")}`), "skip";
    if (!state.listId) return d.push("no segment to enrol on"), "skip";
    type Flow = { id?: string; name?: string; actions?: { actionTypeId?: string; fields?: Record<string, unknown> }[] };
    // Learn the action from the portal's own workflow that sets contacts to marketing.
    let model: Flow | undefined;
    const isStatusAction = (a: { fields?: unknown }) => /marketable|marketing_contact|marketing contact/i.test(JSON.stringify(a.fields ?? {}));
    if (state.marketingWorkflowId) {
      const g = await call("GET", `/automation/v4/flows/${state.marketingWorkflowId}`);
      d.push(`flow ${state.marketingWorkflowId}: ${g.ok ? "read" : said(g)}`);
      if (g.ok) model = g.body as Flow;
    }
    if (!model?.actions?.some(isStatusAction)) {
      const l = await call("GET", "/automation/v4/flows?limit=100");
      const ids = ((l.body as { results?: { id: string }[] } | null)?.results ?? []).map((f) => f.id);
      d.push(`flows listed: ${l.ok ? ids.length : said(l)}`);
      for (const id of ids.slice(0, 40)) {
        const g = await call("GET", `/automation/v4/flows/${id}`);
        if (g.ok && (g.body as Flow).actions?.some(isStatusAction)) {
          model = g.body as Flow;
          break;
        }
      }
    }
    const action = model?.actions?.find(isStatusAction);
    if (!action) return d.push("found no workflow with a marketing status action to learn from"), "fail";
    d.push(`learned from "${model?.name}" (${model?.id}): actionTypeId ${action.actionTypeId}, fields ${JSON.stringify(action.fields)}`);
    // The same action with the value flipped to non-marketing.
    const fields = JSON.parse(JSON.stringify(action.fields ?? {}).replace(/"(true|MARKETABLE|MARKETING|SET_AS_MARKETING|marketing)"/g, (_m, v: string) => `"${({ true: "false", MARKETABLE: "NON_MARKETABLE", MARKETING: "NON_MARKETING", SET_AS_MARKETING: "SET_AS_NON_MARKETING", marketing: "non_marketing" } as Record<string, string>)[v]}"`));
    const body = {
      type: "CONTACT_FLOW", objectTypeId: "0-1", flowType: "WORKFLOW", isEnabled: false, name: `EM spike · ${tag} · Set to non-marketing`,
      startActionId: "1", nextAvailableActionId: "2",
      actions: [{ type: "SINGLE_CONNECTION", actionId: "1", actionTypeVersion: 0, actionTypeId: action.actionTypeId, fields }],
      enrollmentCriteria: {
        type: "LIST_BASED", shouldReEnroll: true, unEnrollObjectsNotMeetingCriteria: false, reEnrollmentTriggersFilterBranches: [],
        listFilterBranch: { filterBranchType: "OR", filters: [], filterBranches: [{ filterBranchType: "AND", filterBranches: [], filters: [{ filterType: "IN_LIST", listId: state.listId, operator: "IN_LIST" }] }] },
      },
    };
    const c = await call("POST", "/automation/v4/flows", body);
    state.flowId = c.ok ? String((c.body as { id?: string }).id ?? "") || undefined : undefined;
    const back = state.flowId ? ((await call("GET", `/automation/v4/flows/${state.flowId}`)).body as Flow | null) : null;
    d.push(`create (disabled): ${c.ok ? `${c.status}, flow ${state.flowId}` : said(c)}`, back ? `read back: fields ${JSON.stringify(back.actions?.[0]?.fields)}` : "");
    d.splice(0, d.length, ...d.filter(Boolean));
    return c.ok ? "pass" : "fail";
  });

  await step("behavioural-events", "Can we define and send a custom behavioural event (Enterprise)?", async (d) => {
    const missing = BEHAVIOURAL_EVENT_SCOPES.filter((s) => !state.scopes.includes(s));
    if (missing.length) return d.push(`not granted: ${missing.join(", ")}`), "skip";
    const r = await call("POST", "/events/v3/event-definitions", {
      label: `EM spike ${tag}`, name: `em_spike_${tag.replace(/-/g, "_")}`, description: "Event manager spike; safe to delete", primaryObject: "CONTACT",
      propertyDefinitions: [{ name: "em_event_id", label: "Event id", type: "string" }],
    });
    if (!r.ok) return d.push(`define: ${said(r)}`), "fail";
    const def = r.body as { fullyQualifiedName?: string; name?: string };
    state.eventDefinition = def.name;
    const s = await call("POST", "/events/v3/send", { eventName: def.fullyQualifiedName, email: opts.email, properties: { em_event_id: "spike" } });
    d.push(`definition ${def.fullyQualifiedName}`, `send ${s.ok ? s.status : said(s)}`);
    return s.ok ? "pass" : "fail";
  });

  await step("cleanup", "Remove what the spike created", async (d) => {
    if (opts.keep) return d.push("kept (--keep)"), "skip";
    const done: string[] = [];
    const del = async (what: string, path: string) => done.push(`${what} ${(await call("DELETE", path)).status}`);
    // First, as it is enrolled on the segment.
    if (state.flowId) await del("workflow", `/automation/v4/flows/${state.flowId}`);
    if (state.cloneId && !state.sent) await del("email", `/marketing/v3/emails/${state.cloneId}`);
    if (state.cloneId && state.sent) done.push("sent email kept (HubSpot keeps sent emails)");
    // A sent email references its segment (HubSpot refuses to delete it, run 4) and is still being
    // delivered to the contact, so both stay; remove them in HubSpot once the email has arrived.
    if (state.listId && !state.sent) await del("segment", `/crm/v3/lists/${state.listId}`);
    if (state.marketingEvent) await del("marketing event", `/marketing/v3/marketing-events/events/${state.marketingEvent.externalEventId}?externalAccountId=${state.marketingEvent.externalAccountId}`);
    if (state.eventDefinition) await del("event definition", `/events/v3/event-definitions/${state.eventDefinition}`);
    if (state.contactId && !state.sent) await del("contact", `/crm/v3/objects/contacts/${state.contactId}`);
    if (state.sent) done.push(`segment ${state.listId} and contact ${state.contactId} kept for the delivery`);
    if (state.singleSendOurs && state.singleSendId && !state.singleSent) await del("single-send email", `/marketing/v3/emails/${state.singleSendId}`);
    for (const r of state.recipients ?? []) {
      if (!r.contactId || r.which === "plain") continue;
      if (state.singleSent) done.push(`single-send contact ${r.which} ${r.contactId} kept, to see the send on its timeline`);
      else await del(`single-send contact ${r.which}`, `/crm/v3/objects/contacts/${r.contactId}`);
    }
    if (state.singleSent && state.singleSendOurs) done.push(`single-send email ${state.singleSendId} kept`);
    if (state.otherTypeEmailId) await del("other-type email", `/marketing/v3/emails/${state.otherTypeEmailId}`);
    d.push(...done);
    return "info";
  });

  return { results, recordings };
}

/** The results as a Markdown table, for docs/hubspot.md. */
export function summarise(results: StepResult[], portalId: string, at: Date): string {
  const icon: Record<Outcome, string> = { pass: "✅", fail: "❌", skip: "⏭️", info: "ℹ️" };
  const rows = results.map((r) => `| ${r.id} | ${r.question} | ${icon[r.outcome]} ${r.outcome} | ${r.details.join("<br>").replace(/\|/g, "\\|")} |`);
  return [`# HubSpot spike, portal ${portalId}, ${at.toISOString()}`, "", "| Step | Question | Outcome | What HubSpot said |", "|---|---|---|---|", ...rows, ""].join("\n");
}
