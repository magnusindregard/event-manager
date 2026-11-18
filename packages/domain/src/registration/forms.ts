import { randomBytes } from "node:crypto";
import type { Tx } from "@event-manager/db";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, can, getAccount, recordAudit } from "../tenancy/index.js";
import { decryptAnswer, encryptAnswer } from "./secrets.js";

// Registration forms (docs/registration.md, "Form fields"). Name and email are always
// collected; the guest is the event's guestAllowed setting. Everything else is a field the
// event manager adds. A saved form is a numbered version: answers keep the field ids they
// were given to, and old versions stay readable, so changing the form never loses answers.
//
// Sensitive answers (dietary needs, free text marked sensitive) are stored encrypted, need
// the attendee's consent, are shown only to staff with registrations.sensitive and are
// deleted soon after the occurrence (retention.ts).

export type FieldType = "text" | "dietary" | "checkbox" | "choice";
export const FIELD_TYPES: readonly FieldType[] = ["text", "dietary", "checkbox", "choice"];

/** Text per locale. */
export type Localized = Record<string, string>;

export interface ChoiceOption {
  id: string;
  label: Localized;
}

export interface FormField {
  /** Stable across versions; answers are keyed by it. */
  id: string;
  type: FieldType;
  label: Localized;
  help: Localized;
  required: boolean;
  /** Always true for dietary; may be set on text. */
  sensitive: boolean;
  /** text: a text area instead of one line. Dietary is always multiline. */
  multiline: boolean;
  /** choice: several options may be ticked. */
  multiple: boolean;
  /** choice only. */
  options: ChoiceOption[];
}

export interface Form {
  eventId: string;
  /** 0: no form saved yet. */
  version: number;
  fields: FormField[];
}

/** A field as staff send it: ids are optional for new fields and options. */
export type FormFieldInput = Partial<Omit<FormField, "type" | "label" | "options">> & {
  type: FieldType;
  label: Localized;
  options?: (Partial<ChoiceOption> & { label: Localized })[];
};

/** An answer's value: text for text and dietary, true for a ticked checkbox, option ids for choice. */
export type AnswerValue = string | boolean | string[];
export type Answers = Record<string, AnswerValue>;

const MAX_FIELDS = 30;
const MAX_OPTIONS = 50;
const ID_RE = /^[a-z0-9]{1,40}$/;
const newKey = () => randomBytes(6).toString("hex");

const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });

function localized(field: string, v: unknown, locales: readonly string[], max: number, need: string | null): Localized {
  if (v === undefined || v === null) {
    if (need) throw invalid(field, `Enter a text in ${need}`);
    return {};
  }
  if (typeof v !== "object" || Array.isArray(v)) throw invalid(field, "Must be an object of texts per locale");
  const out: Localized = {};
  for (const [locale, text] of Object.entries(v as Record<string, unknown>)) {
    if (!locales.includes(locale)) throw invalid(`${field}.${locale}`, `${locale} is not one of the account's locales`);
    if (typeof text !== "string") throw invalid(`${field}.${locale}`, "Must be text");
    const t = text.trim();
    if (t.length > max) throw invalid(`${field}.${locale}`, `At most ${max} characters`);
    if (t) out[locale] = t;
  }
  if (need && !out[need]) throw invalid(field, `Enter a text in ${need}`);
  return out;
}

/** Pure: checks and normalizes a form. New fields and options get ids. */
export function normalizeForm(input: readonly FormFieldInput[], locales: readonly string[], defaultLocale: string): FormField[] {
  if (!Array.isArray(input)) throw invalid("fields", "Must be a list of fields");
  if (input.length > MAX_FIELDS) throw invalid("fields", `At most ${MAX_FIELDS} fields`);
  const ids = new Set<string>();
  let dietary = 0;
  return input.map((f, i) => {
    const at = `fields.${i}`;
    if (!f || !FIELD_TYPES.includes(f.type)) throw invalid(`${at}.type`, `Type is one of ${FIELD_TYPES.join(", ")}`);
    const id = f.id ?? newKey();
    if (!ID_RE.test(id)) throw invalid(`${at}.id`, "Ids are 1–40 lowercase letters and digits");
    if (ids.has(id)) throw invalid(`${at}.id`, "Two fields have the same id");
    ids.add(id);
    if (f.type === "dietary" && ++dietary > 1) throw invalid(`${at}.type`, "Only one dietary field per form");
    const options: ChoiceOption[] = [];
    if (f.type === "choice") {
      const raw = f.options ?? [];
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OPTIONS) throw invalid(`${at}.options`, `A choice has 1–${MAX_OPTIONS} options`);
      const optIds = new Set<string>();
      raw.forEach((o, j) => {
        const oid = o.id ?? newKey();
        if (!ID_RE.test(oid) || optIds.has(oid)) throw invalid(`${at}.options.${j}.id`, "Option ids are unique, 1–40 lowercase letters and digits");
        optIds.add(oid);
        options.push({ id: oid, label: localized(`${at}.options.${j}.label`, o.label, locales, 200, defaultLocale) });
      });
    }
    return {
      id,
      type: f.type,
      label: localized(`${at}.label`, f.label, locales, 300, defaultLocale),
      help: localized(`${at}.help`, f.help, locales, 1000, null),
      required: f.required === true,
      sensitive: f.type === "dietary" || (f.type === "text" && f.sensitive === true),
      multiline: f.type === "dietary" || (f.type === "text" && f.multiline === true),
      multiple: f.type === "choice" && f.multiple === true,
      options,
    };
  });
}

/** Pure: JSON with object keys sorted, since jsonb does not keep key order. */
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v);

/** Pure: whether two forms are the same, so saving an unchanged form adds no version. */
const sameFields = (a: readonly FormField[], b: readonly FormField[]) => stable(a) === stable(b);

const toFields = (v: unknown): FormField[] => (Array.isArray(v) ? (v as FormField[]) : []);

/** The event's current form. */
export async function getForm(tx: Tx, eventId: string): Promise<Form> {
  const row = await tx.selectFrom("registration.form_version").select(["version", "fields"]).where("event_id", "=", eventId).orderBy("version", "desc").limit(1).executeTakeFirst();
  return { eventId, version: row?.version ?? 0, fields: toFields(row?.fields) };
}

/**
 * Saves the form as its next version. Requires content.write: building the form is content,
 * reading the answers is not. expectedVersion is the version the editor started from.
 */
export async function saveForm(tx: Tx, ctx: ActorContext, eventId: string, expectedVersion: number, input: readonly FormFieldInput[]): Promise<Form> {
  assertCan(ctx, "content.write");
  const event = await tx.selectFrom("catalog.event").select("id").where("id", "=", eventId).forUpdate().executeTakeFirst();
  if (!event) throw new DomainError("not_found", "Event not found");
  const before = await getForm(tx, eventId);
  if (before.version !== expectedVersion) throw new DomainError("version_conflict", "The form was changed by someone else", { currentVersion: before.version });
  const account = await getAccount(tx);
  const fields = normalizeForm(input, account.locales, account.defaultLocale);
  if (sameFields(fields, before.fields)) return before;
  await assertClassificationKept(tx, eventId, fields);
  const version = before.version + 1;
  await tx.insertInto("registration.form_version")
    .values({ tenant_id: ctx.tenantId, event_id: eventId, version, fields: JSON.stringify(fields), created_by: ctx.userId })
    .execute();
  const prev = new Set(before.fields.map((f) => f.id));
  const next = new Set(fields.map((f) => f.id));
  await recordAudit(tx, ctx, {
    action: "event.form_saved", entityType: "event", entityId: eventId,
    diff: { version, added: [...next].filter((id) => !prev.has(id)), removed: [...prev].filter((id) => !next.has(id)) },
  });
  return { eventId, version, fields };
}

/**
 * A field's answers live in registration.answer or, when sensitive, encrypted in
 * registration.sensitive_answer, with the matching retention. Changing whether a field is
 * sensitive would leave earlier answers in the wrong place, readable by staff without
 * registrations.sensitive or kept past the sensitive retention, so it is refused once the
 * field has answers. A new field (new id) can be added instead.
 */
async function assertClassificationKept(tx: Tx, eventId: string, fields: readonly FormField[]): Promise<void> {
  const known = new Map((await answerFields(tx, eventId)).map((f) => [f.id, f]));
  const changed = fields.map((f, i) => ({ f, i })).filter(({ f }) => known.has(f.id) && known.get(f.id)!.sensitive !== f.sensitive);
  if (changed.length === 0) return;
  const ids = changed.map(({ f }) => f.id);
  const answered = (table: "registration.answer" | "registration.sensitive_answer") =>
    tx.selectFrom(table).innerJoin("registration.registration as r", "r.id", `${table}.registration_id`)
      .select(`${table}.field_id as fieldId`).distinct()
      .where("r.event_id", "=", eventId).where(`${table}.field_id`, "in", ids).execute();
  const [a, b] = await Promise.all([answered("registration.answer"), answered("registration.sensitive_answer")]);
  const has = new Set([...a, ...b].map((r) => r.fieldId));
  const hit = changed.find(({ f }) => has.has(f.id));
  if (hit) {
    throw invalid(`fields.${hit.i}.sensitive`, "This field already has answers, so whether it is sensitive cannot change. Add a new field instead");
  }
}

/**
 * The fields to show answers under: the current form, then fields from older versions that
 * were removed since (retired: true), so answers given to them stay readable. For the same
 * reason a choice keeps options that later versions removed, after its current ones.
 */
export async function answerFields(tx: Tx, eventId: string): Promise<(FormField & { retired: boolean })[]> {
  const rows = await tx.selectFrom("registration.form_version").select(["version", "fields"]).where("event_id", "=", eventId).orderBy("version", "desc").execute();
  const out: (FormField & { retired: boolean })[] = [];
  const byId = new Map<string, FormField & { retired: boolean }>();
  rows.forEach((r, i) => {
    for (const f of toFields(r.fields)) {
      const newer = byId.get(f.id);
      if (!newer) {
        const field = { ...f, options: [...f.options], retired: i > 0 };
        byId.set(f.id, field);
        out.push(field);
        continue;
      }
      for (const o of f.options) if (!newer.options.some((n) => n.id === o.id)) newer.options.push(o);
    }
  });
  return out;
}

/** Staff: the event's form (content.read). */
export async function getFormForStaff(tx: Tx, ctx: ActorContext, eventId: string): Promise<Form> {
  assertCan(ctx, "content.read");
  return getForm(tx, eventId);
}

/** Staff: the fields to show an occurrence's answers under, without sensitive ones unless the caller may see them. */
export async function visibleAnswerFields(tx: Tx, ctx: ActorContext, occurrenceId: string): Promise<(FormField & { retired: boolean })[]> {
  assertCan(ctx, "registrations.read");
  const occ = await tx.selectFrom("catalog.occurrence").select("event_id").where("id", "=", occurrenceId).executeTakeFirst();
  if (!occ) throw new DomainError("not_found", "Occurrence not found");
  const ok = can(ctx, "registrations.sensitive");
  return (await answerFields(tx, occ.event_id)).filter((f) => ok || !f.sensitive);
}

// ── Answers ─────────────────────────────────────────────────────────────────

export interface AnswerInput {
  /** By field id. Text: a string; checkbox: true, "1" or "on"; choice: an option id or a list of them. */
  answers?: Record<string, unknown>;
  /** Agreement to sensitive answers being stored; needed when any is given. */
  consent?: boolean;
}

export interface CheckedAnswers {
  plain: Answers;
  sensitive: Answers;
}

const TRUE = new Set([true, "1", "on", "true", "yes"]);

/**
 * Pure: checks answers against a form. Empty answers are left out. required: whether
 * required fields must be answered (attendees; staff may leave them out).
 */
export function checkAnswers(fields: readonly FormField[], input: AnswerInput, required: boolean): CheckedAnswers {
  const raw = input.answers ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("answers", "Must be an object of answers by field id");
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const id of Object.keys(raw)) if (!byId.has(id)) throw invalid(`answers.${id}`, "Unknown field");
  const out: CheckedAnswers = { plain: {}, sensitive: {} };
  for (const f of fields) {
    const at = `answers.${f.id}`;
    const v = raw[f.id];
    let value: AnswerValue | null;
    if (f.type === "text" || f.type === "dietary") {
      if (v !== undefined && v !== null && typeof v !== "string") throw invalid(at, "Must be text");
      const t = (v ?? "").replace(/\r\n/g, "\n").trim();
      const max = f.multiline ? 2000 : 300;
      if (t.length > max) throw invalid(at, `At most ${max} characters`);
      value = t || null;
    } else if (f.type === "checkbox") {
      value = TRUE.has(v as never) ? true : null;
    } else {
      const ids = v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v];
      if (!ids.every((x): x is string => typeof x === "string")) throw invalid(at, "Must be option ids");
      const unique = [...new Set(ids)];
      if (!unique.every((x) => f.options.some((o) => o.id === x))) throw invalid(at, "Unknown option");
      if (!f.multiple && unique.length > 1) throw invalid(at, "Choose one option");
      // In the form's order, so the same choice always reads the same.
      value = unique.length ? f.options.map((o) => o.id).filter((id) => unique.includes(id)) : null;
    }
    if (value === null) {
      if (required && f.required) throw invalid(at, "This field is required");
      continue;
    }
    (f.sensitive ? out.sensitive : out.plain)[f.id] = value;
  }
  if (Object.keys(out.sensitive).length > 0 && input.consent !== true) throw invalid("consent", "Agree to the storing of sensitive information, or leave those fields empty");
  return out;
}

/**
 * Replaces a registration's answers with checked ones and records the form version. With
 * keepSensitive (staff without registrations.sensitive), stored sensitive answers are left
 * as they are.
 */
export async function writeAnswers(
  tx: Tx, tenantId: string, registrationId: string, form: Form, answers: CheckedAnswers, opts: { keepSensitive?: boolean; now?: Date } = {},
): Promise<void> {
  await tx.deleteFrom("registration.answer").where("registration_id", "=", registrationId).execute();
  const plain = Object.entries(answers.plain);
  if (plain.length) {
    await tx.insertInto("registration.answer")
      .values(plain.map(([field_id, v]) => ({ tenant_id: tenantId, registration_id: registrationId, field_id, value: JSON.stringify(v) })))
      .execute();
  }
  const sensitive = Object.entries(answers.sensitive);
  if (!opts.keepSensitive) {
    await tx.deleteFrom("registration.sensitive_answer").where("registration_id", "=", registrationId).execute();
    const rows = [];
    for (const [field_id, v] of sensitive) {
      rows.push({ tenant_id: tenantId, registration_id: registrationId, field_id, ciphertext: await encryptAnswer(tx, tenantId, registrationId, field_id, v) });
    }
    if (rows.length) await tx.insertInto("registration.sensitive_answer").values(rows).execute();
  }
  await tx.updateTable("registration.registration")
    .set({
      form_version: form.version || null,
      ...(opts.keepSensitive ? {} : { sensitive_consent_at: sensitive.length ? (opts.now ?? new Date()) : null }),
    })
    .where("id", "=", registrationId).execute();
}

/** Who reads answers: staff see sensitive ones with registrations.sensitive; the attendee sees their own. */
export type AnswerReader = { kind: "attendee" } | { kind: "staff"; ctx: ActorContext };

export const canReadSensitive = (reader: AnswerReader) => reader.kind === "attendee" || can(reader.ctx, "registrations.sensitive");

/** Answers by registration id; sensitive ones only when the reader may see them. */
export async function readAnswers(tx: Tx, tenantId: string, registrationIds: readonly string[], reader: AnswerReader): Promise<Map<string, Answers>> {
  const out = new Map<string, Answers>(registrationIds.map((id) => [id, {}]));
  if (registrationIds.length === 0) return out;
  const plain = await tx.selectFrom("registration.answer").select(["registration_id", "field_id", "value"]).where("registration_id", "in", registrationIds).execute();
  for (const a of plain) out.get(a.registration_id)![a.field_id] = a.value as AnswerValue;
  if (canReadSensitive(reader)) {
    const enc = await tx.selectFrom("registration.sensitive_answer").select(["registration_id", "field_id", "ciphertext"]).where("registration_id", "in", registrationIds).execute();
    for (const a of enc) out.get(a.registration_id)![a.field_id] = (await decryptAnswer(tx, tenantId, a.registration_id, a.field_id, a.ciphertext)) as AnswerValue;
  }
  return out;
}

/** Which registrations have sensitive answers stored, without decrypting them. */
export async function hasSensitiveAnswers(tx: Tx, registrationIds: readonly string[]): Promise<Set<string>> {
  if (registrationIds.length === 0) return new Set();
  const rows = await tx.selectFrom("registration.sensitive_answer").select("registration_id").distinct().where("registration_id", "in", registrationIds).execute();
  return new Set(rows.map((r) => r.registration_id));
}

/** Pure: the text of a localized string, falling back to the default locale, then any. */
export const pickText = (l: Localized, locale: string, fallback: string): string => l[locale] ?? l[fallback] ?? Object.values(l)[0] ?? "";

/** Pure: an answer as text, e.g. for the door list. */
export function answerText(field: FormField, value: AnswerValue | undefined, locale: string, fallback: string, yes = "✓"): string {
  if (value === undefined) return "";
  if (field.type === "checkbox") return value === true ? yes : "";
  if (field.type === "choice" && Array.isArray(value)) {
    return value.map((id) => field.options.find((o) => o.id === id)).filter(Boolean).map((o) => pickText(o!.label, locale, fallback)).join(", ");
  }
  return String(value);
}

/** Used by retention: removes all answers of the given registrations. */
export async function deleteAnswers(tx: Tx, registrationIds: readonly string[]): Promise<void> {
  if (registrationIds.length === 0) return;
  await tx.deleteFrom("registration.answer").where("registration_id", "in", registrationIds).execute();
  await tx.deleteFrom("registration.sensitive_answer").where("registration_id", "in", registrationIds).execute();
}
