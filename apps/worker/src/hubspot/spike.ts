import { randomBytes } from "node:crypto";
import { GUEST_KEY_PROPERTY, OPTIONAL_SCOPES, PROPERTY_GROUP, REQUIRED_SCOPES } from "@event-manager/hubspot";

// HubSpot connector milestone 0, the spike (docs/hubspot.md): checks what milestones 2–6 assume
// about HubSpot, on a developer test portal, and records every answer. Each step stands alone:
// a step that fails is a finding, not a reason to stop. Only a token for another portal than the
// one named stops the run, so it never writes to a real portal by mistake.
//
// It writes to the portal: a test contact (your own address), a static segment, a marketing
// event with attendance, a clone of a template email, and with the optional scopes a custom
// event definition. Cleanup removes them unless `keep` is set. Publishing the email sends a
// real email to the test contact, so it only runs with `send`.

export interface SpikeOptions {
  /** The portal the token must belong to. */
  portalId: string;
  /** The test contact; use an inbox you can read. Redacted from the recordings. */
  email: string;
  /** A marketing email designed as a template, with [[em:invitation_link]] in it. */
  templateEmailId?: string;
  /** Publish the draft: sends a real email to `email`. */
  send: boolean;
  /** Leave what the spike created in the portal. */
  keep: boolean;
  /** Base of the personal link put into the draft. */
  attendeeUrl: string;
  now?: Date;
}

export interface SpikeDeps {
  accessToken: string;
  fetch: typeof fetch;
  log: (line: string) => void;
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
}

export const PLACEHOLDER = "[[em:invitation_link]]";
const API = "https://api.hubapi.com";
const REDACTED_EMAIL = "guest@example.com";

class Abort extends Error {}

interface State {
  scopes: string[];
  contactId?: string;
  listId?: string;
  marketingEvent?: { externalAccountId: string; externalEventId: string };
  cloneId?: string;
  sent?: boolean;
  eventDefinition?: string;
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

  const redact = (v: unknown): unknown =>
    v === undefined ? undefined : JSON.parse(JSON.stringify(v).split(deps.accessToken).join("«token»").split(opts.email).join(REDACTED_EMAIL));

  async function call(method: string, path: string, body?: unknown): Promise<Response_> {
    const headers: Record<string, string> = { authorization: `Bearer ${deps.accessToken}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let status = 0;
    let parsed: unknown;
    try {
      const res = await deps.fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      status = res.status;
      const text = await res.text();
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text.slice(0, 2000);
      }
    } catch (e) {
      parsed = { error: e instanceof Error ? e.message : String(e) };
    }
    recordings.push({ step: current, method, path: String(redact(path)), status, request: redact(body), response: redact(parsed) });
    deps.log(`  ${method} ${String(redact(path))} → ${status}`);
    return { status, ok: status >= 200 && status < 300, body: parsed };
  }

  const said = (r: Response_) => {
    const b = r.body as { message?: string; category?: string } | null;
    return `${r.status}${b?.category ? ` ${b.category}` : ""}${b?.message ? `: ${b.message}` : ""}`;
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
    d.push(ro.ok ? `read-only accepted: ${JSON.stringify((ro.body as { modificationMetadata?: unknown }).modificationMetadata)}` : `read-only refused: ${said(ro)}`);
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
    state.marketingEvent = { externalAccountId, externalEventId };
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
    const e = g.body as { type?: string; emailTemplateMode?: string; content?: unknown } | null;
    const has = JSON.stringify(e?.content ?? {}).includes(PLACEHOLDER);
    d.push(`clone ${state.cloneId}, type ${e?.type}, mode ${e?.emailTemplateMode ?? "?"}`, has ? "placeholder found in content" : "placeholder NOT found in content");
    return has ? "pass" : "fail";
  });

  await step("email-draft", "Can we set name, subject, preview text, recipients (our segment) and replace the placeholder with the personal link?", async (d) => {
    if (!state.cloneId) return d.push("no clone"), "skip";
    const g = await call("GET", `/marketing/v3/emails/${state.cloneId}`);
    const content = (g.body as { content?: unknown } | null)?.content ?? {};
    const link = `${opts.attendeeUrl}/h/spike-event/{{ contact.${GUEST_KEY_PROPERTY.name} }}`;
    const replaced = JSON.parse(JSON.stringify(content).split(PLACEHOLDER).join(link.replace(/"/g, '\\"')));
    const subject = `EM spike ${tag}`;
    const patch = await call("PATCH", `/marketing/v3/emails/${state.cloneId}`, {
      name: `EM spike · ${tag} · Invitation`, subject, content: replaced,
      ...(state.listId ? { to: { contactIlsLists: { include: [state.listId], exclude: [] } } } : {}),
    });
    // Where preview text lives is one of the questions: try it on its own so a refusal is visible.
    const preview = await call("PATCH", `/marketing/v3/emails/${state.cloneId}`, { previewText: `Preview ${tag}` });
    const after = (await call("GET", `/marketing/v3/emails/${state.cloneId}`)).body as { subject?: string; to?: { contactIlsLists?: { include?: (string | number)[] } }; content?: unknown } | null;
    const text = JSON.stringify(after ?? {});
    const checks = {
      patched: patch.ok,
      subject: after?.subject === subject,
      recipients: !state.listId || (after?.to?.contactIlsLists?.include ?? []).map(String).includes(state.listId),
      link: text.includes(`contact.${GUEST_KEY_PROPERTY.name}`),
      placeholderGone: !text.includes(PLACEHOLDER),
    };
    d.push(...Object.entries(checks).map(([k, v]) => `${k} ${v ? "✓" : "✗"}`), patch.ok ? "" : `patch: ${said(patch)}`, `previewText ${preview.ok && text.includes(`Preview ${tag}`) ? "✓" : `✗ ${preview.ok ? "(accepted, not found on read)" : said(preview)}`}`);
    d.splice(0, d.length, ...d.filter(Boolean));
    return Object.values(checks).every(Boolean) ? "pass" : "fail";
  });

  await step("email-send", "Can we publish (send) the draft through the API, and what does HubSpot say when the plan does not allow it?", async (d) => {
    if (!state.cloneId) return d.push("no draft"), "skip";
    if (!opts.send) return d.push(`pass --send to publish: it sends a real email to ${opts.email}`), "skip";
    const r = await call("POST", `/marketing/v3/emails/${state.cloneId}/publish`);
    state.sent = r.ok;
    const after = (await call("GET", `/marketing/v3/emails/${state.cloneId}`)).body as { state?: string; publishDate?: string } | null;
    d.push(r.ok ? `published (${r.status})` : `refused: ${said(r)} – the error a non-Enterprise portal gives is our capability check`, `state ${after?.state}, publishDate ${after?.publishDate ?? "-"}`, "check the inbox: does the link open /h/spike-event/<the contact's key>?");
    return r.ok ? "pass" : "fail";
  });

  await step("behavioural-events", "Can we define and send a custom behavioural event (Enterprise)?", async (d) => {
    const missing = OPTIONAL_SCOPES.filter((s) => !state.scopes.includes(s));
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
    if (state.cloneId && !state.sent) await del("email", `/marketing/v3/emails/${state.cloneId}`);
    if (state.cloneId && state.sent) done.push("sent email kept (HubSpot keeps sent emails)");
    if (state.listId) await del("segment", `/crm/v3/lists/${state.listId}`);
    if (state.marketingEvent) await del("marketing event", `/marketing/v3/marketing-events/events/${state.marketingEvent.externalEventId}?externalAccountId=${state.marketingEvent.externalAccountId}`);
    if (state.eventDefinition) await del("event definition", `/events/v3/event-definitions/${state.eventDefinition}`);
    if (state.contactId) await del("contact", `/crm/v3/objects/contacts/${state.contactId}`);
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
