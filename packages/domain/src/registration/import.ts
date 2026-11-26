import ExcelJS from "exceljs";
import { type InvitationStatus, newId, sql, type Tx } from "@event-manager/db";
import * as catalog from "../catalog/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, getAccount, recordAudit } from "../tenancy/index.js";
import { invitationColumns, normalizeEmail, toInvitation } from "./invitations.js";

// Guest list import (docs/registration.md, "Guest list import"): CSV or XLSX, typically an
// export from the client's CRM or MA tool. The file is staged as rows; staff map columns,
// see a preview with row errors, and import. Re-importing matches on email: new rows are
// added, existing ones updated, nothing duplicated. Guests missing from the file are listed,
// never removed silently.

export const IMPORT_FIELDS = ["email", "name", "firstName", "lastName", "locale", "guestAllowed", "externalContactId"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
/** Field → column index in the file. */
export type ImportMapping = Partial<Record<ImportField, number>>;

export const MAX_IMPORT_ROWS = 20_000;
const MAX_COLUMNS = 100;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });

// ── Parsing (pure) ────────────────────────────────────────────────────────────

export interface ParsedFile {
  headers: string[];
  rows: string[][];
}

/** RFC 4180 CSV with the delimiter sniffed from the header line (Excel in Norway writes semicolons). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delimiter = [";", ",", "\t"].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0]!.d;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** UTF-8, or Windows-1252 when the bytes are not valid UTF-8 (older Excel CSV exports). */
export function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

function tidy(raw: string[][]): ParsedFile {
  const rows = raw.map((r) => r.map((c) => (c ?? "").replace(/\s+/g, " ").trim())).filter((r) => r.some((c) => c !== ""));
  if (rows.length === 0) throw invalid("file", "The file is empty");
  const headers = rows[0]!;
  if (headers.length > MAX_COLUMNS) throw invalid("file", `The file has more than ${MAX_COLUMNS} columns`);
  const body = rows.slice(1);
  if (body.length > MAX_IMPORT_ROWS) throw invalid("file", `The file has more than ${MAX_IMPORT_ROWS} rows`);
  return { headers: headers.map((h, i) => h || `#${i + 1}`), rows: body.map((r) => headers.map((_, i) => r[i] ?? "")) };
}

/** Reads the first sheet of an XLSX file, or a CSV file; the first non-empty row is the header. */
export async function parseGuestFile(fileName: string, content: Buffer): Promise<ParsedFile> {
  if (content.length === 0) throw invalid("file", "The file is empty");
  if (content.length > MAX_IMPORT_BYTES) throw invalid("file", "The file is larger than 10 MB");
  const isZip = content[0] === 0x50 && content[1] === 0x4b;
  if (/\.xlsx$/i.test(fileName) || isZip) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(content as unknown as ArrayBuffer);
    } catch {
      throw invalid("file", "The file could not be read as an Excel workbook (.xlsx)");
    }
    const sheet = wb.worksheets[0];
    if (!sheet) throw invalid("file", "The workbook has no sheets");
    const raw: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(row.cellCount, MAX_COLUMNS + 1); c++) cells.push(row.getCell(c).text ?? "");
      raw.push(cells);
    });
    return tidy(raw);
  }
  if (/\.xls$/i.test(fileName)) throw invalid("file", "Save the file as .xlsx or .csv; the old .xls format is not supported");
  return tidy(parseCsv(decodeText(content)));
}

// ── Mapping ───────────────────────────────────────────────────────────────────

const GUESSES: Record<ImportField, RegExp> = {
  email: /^(e-?post(adresse)?|e-?mail( address)?|mail)$/i,
  name: /^(navn|fullt navn|name|full name|kontakt|contact)$/i,
  firstName: /^(fornavn|first ?name|given name)$/i,
  lastName: /^(etternavn|last ?name|surname|family name)$/i,
  locale: /^(spr[aå]k|language|locale|lang)$/i,
  guestAllowed: /^(gjest|ledsager|kan ta med gjest|guest|plus ?one|guest allowed)$/i,
  externalContactId: /^(kontakt-?id|contact ?id|crm-?id|id)$/i,
};

/** Pure: a mapping from the account's remembered headers, then from common header names. */
export function suggestMapping(headers: readonly string[], remembered: Record<string, string> | null): ImportMapping {
  const out: ImportMapping = {};
  const used = new Set<number>();
  const take = (f: ImportField, i: number) => {
    if (i >= 0 && !used.has(i) && out[f] === undefined) {
      out[f] = i;
      used.add(i);
    }
  };
  const lower = headers.map((h) => h.toLowerCase());
  if (remembered) for (const f of IMPORT_FIELDS) if (remembered[f]) take(f, lower.indexOf(remembered[f]!.toLowerCase()));
  for (const f of IMPORT_FIELDS) take(f, headers.findIndex((h, i) => !used.has(i) && GUESSES[f].test(h)));
  if (out.email === undefined) take("email", headers.findIndex((h, i) => !used.has(i) && /e-?mail|e-?post/i.test(h)));
  if (out.name !== undefined) {
    delete out.firstName;
    delete out.lastName;
  }
  return out;
}

function assertMapping(m: ImportMapping, columns: number) {
  if (m.email === undefined) throw invalid("mapping.email", "Choose the column with email addresses");
  const seen = new Set<number>();
  for (const [f, i] of Object.entries(m)) {
    if (!IMPORT_FIELDS.includes(f as ImportField)) throw invalid(`mapping.${f}`, "Unknown field");
    if (!Number.isInteger(i) || i! < 0 || i! >= columns) throw invalid(`mapping.${f}`, "No such column");
    if (seen.has(i!)) throw invalid(`mapping.${f}`, "A column can be used for one field only");
    seen.add(i!);
  }
  if (m.name !== undefined && (m.firstName !== undefined || m.lastName !== undefined)) throw invalid("mapping.name", "Use either a name column or first and last name");
}

const YES = /^(ja|j|yes|y|true|1|x|sann)$/i;
const NO = /^(nei|n|no|false|0|usann)$/i;

export interface ImportRow {
  /** Row number in the file, counting the header as row 1. */
  line: number;
  email: string;
  name: string | null;
  locale: string | null;
  guestAllowed: boolean | null;
  externalContactId: string | null;
}

export interface RowError {
  line: number;
  field: ImportField;
  value: string;
  code: "missing_email" | "invalid_email" | "duplicate_email" | "invalid_locale" | "invalid_guest_allowed" | "too_long";
}

/** Pure: applies a mapping to the rows. Rows with an error are left out of `rows`. */
export function mapRows(file: ParsedFile, m: ImportMapping, locales: readonly string[]): { rows: ImportRow[]; errors: RowError[] } {
  assertMapping(m, file.headers.length);
  const rows: ImportRow[] = [];
  const errors: RowError[] = [];
  const seen = new Map<string, number>();
  const cell = (r: string[], f: ImportField) => (m[f] === undefined ? undefined : (r[m[f]!] ?? "").trim());
  const localeOf = (v: string) => {
    const l = v.toLowerCase();
    if (locales.includes(l)) return l;
    if ((l === "no" || l === "norsk" || l === "nn" || l === "norwegian") && locales.includes("nb")) return "nb";
    if ((l === "english" || l === "engelsk") && locales.includes("en")) return "en";
    return null;
  };
  file.rows.forEach((r, i) => {
    const line = i + 2;
    const fail = (field: ImportField, value: string, code: RowError["code"]) => errors.push({ line, field, value, code });
    const rawEmail = cell(r, "email") ?? "";
    if (!rawEmail) return fail("email", "", "missing_email");
    const email = normalizeEmail(rawEmail.replace(/^mailto:/i, ""));
    if (!email) return fail("email", rawEmail, "invalid_email");
    if (seen.has(email)) return fail("email", rawEmail, "duplicate_email");
    seen.set(email, line);

    const name = m.name !== undefined ? cell(r, "name")! : [cell(r, "firstName"), cell(r, "lastName")].filter(Boolean).join(" ");
    if (name.length > 200) return fail(m.name !== undefined ? "name" : "firstName", name, "too_long");
    const rawLocale = cell(r, "locale") ?? "";
    const locale = rawLocale ? localeOf(rawLocale) : null;
    if (rawLocale && !locale) return fail("locale", rawLocale, "invalid_locale");
    const rawGuest = cell(r, "guestAllowed") ?? "";
    const guestAllowed = rawGuest === "" ? null : YES.test(rawGuest) ? true : NO.test(rawGuest) ? false : undefined;
    if (guestAllowed === undefined) return fail("guestAllowed", rawGuest, "invalid_guest_allowed");
    const contact = cell(r, "externalContactId") ?? "";
    if (contact.length > 200) return fail("externalContactId", contact, "too_long");
    rows.push({ line, email, name: name || null, locale, guestAllowed, externalContactId: contact || null });
  });
  return { rows, errors };
}

// ── Staged imports ────────────────────────────────────────────────────────────

export interface ImportDraft {
  id: string;
  eventId: string;
  fileName: string;
  headers: string[];
  /** The first rows, to help with the mapping. */
  sample: string[][];
  rowCount: number;
  mapping: ImportMapping;
  expiresAt: Date;
}

export interface MissingGuest {
  id: string;
  email: string;
  name: string | null;
  status: InvitationStatus;
  /** False for guests who have accepted: cancel their registration first. */
  removable: boolean;
}

export interface ImportPreview {
  rowCount: number;
  added: number;
  updated: number;
  unchanged: number;
  errors: RowError[];
  /** Guests on the list who are not in the file. */
  missing: MissingGuest[];
}

async function draft(tx: Tx, importId: string) {
  const d = await tx.selectFrom("registration.guest_import").selectAll().where("id", "=", importId).where("expires_at", ">", new Date()).executeTakeFirst();
  if (!d) throw new DomainError("not_found", "Import not found or expired; upload the file again");
  return d;
}

async function rememberedMapping(tx: Tx): Promise<Record<string, string> | null> {
  return (await tx.selectFrom("registration.import_mapping").select("mapping").executeTakeFirst())?.mapping ?? null;
}

/** Stages an uploaded file and suggests a column mapping. */
export async function stageImport(tx: Tx, ctx: ActorContext, eventId: string, file: { fileName: string; content: Buffer }): Promise<ImportDraft> {
  assertCan(ctx, "registrations.write");
  const event = await catalog.getEvent(tx, eventId);
  if (event.admissionMode !== "registration") throw new DomainError("conflict", "The event does not take registrations", { eventId });
  const parsed = await parseGuestFile(file.fileName, file.content);
  return stageRows(tx, ctx.tenantId, eventId, ctx.userId, file.fileName, parsed);
}

/**
 * Stages rows from another source than a file (a HubSpot list, fetched by the worker), for staff
 * to map, preview and commit as for a file.
 */
export async function stageRows(tx: Tx, tenantId: string, eventId: string, createdBy: string | null, fileName: string, parsed: ParsedFile): Promise<ImportDraft> {
  if (parsed.rows.length > MAX_IMPORT_ROWS) throw invalid("file", `The list has more than ${MAX_IMPORT_ROWS} guests`);
  // Old drafts with personal data go as soon as someone imports again.
  await tx.deleteFrom("registration.guest_import").where("expires_at", "<=", new Date()).execute();
  const id = newId();
  const row = await tx.insertInto("registration.guest_import")
    .values({ id, tenant_id: tenantId, event_id: eventId, created_by: createdBy, file_name: fileName.slice(0, 255), headers: parsed.headers, rows: JSON.stringify(parsed.rows) })
    .returning(["expires_at"]).executeTakeFirstOrThrow();
  return toDraft(id, eventId, fileName, parsed, row.expires_at, await rememberedMapping(tx));
}

const toDraft = (id: string, eventId: string, fileName: string, parsed: ParsedFile, expiresAt: Date, remembered: Record<string, string> | null): ImportDraft => ({
  id, eventId, fileName, headers: parsed.headers, sample: parsed.rows.slice(0, 5), rowCount: parsed.rows.length,
  mapping: suggestMapping(parsed.headers, remembered), expiresAt,
});

/** A staged import, as the upload returned it: for a source staged in the background. */
export async function getImportDraft(tx: Tx, ctx: ActorContext, importId: string): Promise<ImportDraft> {
  assertCan(ctx, "registrations.write");
  const d = await draft(tx, importId);
  return toDraft(d.id, d.event_id, d.file_name, { headers: d.headers, rows: d.rows as string[][] }, d.expires_at, await rememberedMapping(tx));
}

type Existing = ReturnType<typeof toInvitation>;
const sameRow = (e: Existing, r: ImportRow, m: ImportMapping) =>
  (m.name === undefined && m.firstName === undefined && m.lastName === undefined ? true : e.name === r.name) &&
  (m.locale === undefined || e.locale === r.locale) &&
  (m.guestAllowed === undefined || e.guestAllowed === r.guestAllowed) &&
  (m.externalContactId === undefined || e.externalContactId === r.externalContactId);

async function plan(tx: Tx, eventId: string, d: { headers: string[]; rows: string[][] }, mapping: ImportMapping) {
  const account = await getAccount(tx);
  const { rows, errors } = mapRows({ headers: d.headers, rows: d.rows }, mapping, account.locales);
  const existing = (await tx.selectFrom("registration.guest_invitation").select(invitationColumns).where("event_id", "=", eventId).execute()).map(toInvitation);
  const byEmail = new Map(existing.map((e) => [e.email, e]));
  // Every email in the file counts as present, also on rows with other errors, so a typo in
  // another column never lists the guest for removal.
  const inFile = new Set<string>();
  for (const r of d.rows) {
    const raw = normalizeEmail((r[mapping.email!] ?? "").replace(/^mailto:/i, ""));
    if (raw) inFile.add(raw);
  }
  const added = rows.filter((r) => !byEmail.has(r.email));
  const updated = rows.filter((r) => byEmail.has(r.email) && !sameRow(byEmail.get(r.email)!, r, mapping));
  const unchanged = rows.length - added.length - updated.length;
  const missing: MissingGuest[] = existing.filter((e) => !inFile.has(e.email)).map((e) => ({ id: e.id, email: e.email, name: e.name, status: e.status, removable: e.status !== "accepted" }));
  return { rows, errors, added, updated, unchanged, missing, byEmail };
}

/** What importing with this mapping would do, without saving anything. */
export async function previewImport(tx: Tx, ctx: ActorContext, importId: string, mapping: ImportMapping): Promise<ImportPreview> {
  assertCan(ctx, "registrations.write");
  const d = await draft(tx, importId);
  const p = await plan(tx, d.event_id, d, mapping);
  return { rowCount: d.rows.length, added: p.added.length, updated: p.updated.length, unchanged: p.unchanged, errors: p.errors.slice(0, 500), missing: p.missing };
}

export interface ImportResult {
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  missing: MissingGuest[];
}

/**
 * Imports the valid rows: adds new guests and updates existing ones in the mapped columns
 * only (an empty cell clears the value). Rows with errors are skipped. Remembers the mapping
 * for the account and deletes the staged file.
 */
export async function commitImport(tx: Tx, ctx: ActorContext, importId: string, mapping: ImportMapping): Promise<ImportResult> {
  assertCan(ctx, "registrations.write");
  const d = await draft(tx, importId);
  const p = await plan(tx, d.event_id, d, mapping);
  const nameMapped = mapping.name !== undefined || mapping.firstName !== undefined || mapping.lastName !== undefined;
  const values = p.added.map((r) => ({
    id: newId(), tenant_id: ctx.tenantId, event_id: d.event_id, email: r.email, name: r.name, locale: r.locale,
    guest_allowed: r.guestAllowed, external_contact_id: r.externalContactId,
  }));
  for (let i = 0; i < values.length; i += 1000) await tx.insertInto("registration.guest_invitation").values(values.slice(i, i + 1000)).execute();
  for (const r of p.updated) {
    await tx.updateTable("registration.guest_invitation")
      .set({
        ...(nameMapped ? { name: r.name } : {}),
        ...(mapping.locale !== undefined ? { locale: r.locale } : {}),
        ...(mapping.guestAllowed !== undefined ? { guest_allowed: r.guestAllowed } : {}),
        ...(mapping.externalContactId !== undefined ? { external_contact_id: r.externalContactId } : {}),
        version: sql<number>`version + 1`,
      })
      .where("id", "=", p.byEmail.get(r.email)!.id).execute();
  }
  const byHeader = Object.fromEntries(Object.entries(mapping).map(([f, i]) => [f, d.headers[i!]!]));
  await tx.insertInto("registration.import_mapping").values({ tenant_id: ctx.tenantId, mapping: JSON.stringify(byHeader) })
    .onConflict((oc) => oc.column("tenant_id").doUpdateSet({ mapping: JSON.stringify(byHeader), updated_at: new Date() })).execute();
  await tx.deleteFrom("registration.guest_import").where("id", "=", importId).execute();
  const result = { added: p.added.length, updated: p.updated.length, unchanged: p.unchanged, skipped: p.errors.length, missing: p.missing };
  await recordAudit(tx, ctx, {
    action: "invitation.imported", entityType: "event", entityId: d.event_id,
    diff: { fileName: d.file_name, added: result.added, updated: result.updated, unchanged: result.unchanged, skipped: result.skipped },
  });
  return result;
}

/** Drops a staged file without importing it. */
export async function discardImport(tx: Tx, ctx: ActorContext, importId: string): Promise<void> {
  assertCan(ctx, "registrations.write");
  await tx.deleteFrom("registration.guest_import").where("id", "=", importId).execute();
}
