import type { RegistrationSource, Tx } from "@event-manager/db";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, can, getAccount, recordAudit } from "../tenancy/index.js";
import { answerFields, answerText, type FormField, pickText, readAnswers } from "./forms.js";

// Door list (docs/registration.md, "Occurrence → Registrations"): the confirmed attendees of
// one occurrence in name order, for printing or a spreadsheet at the door. With answers, it
// also carries the form's answers as text, e.g. for the kitchen; sensitive ones only for
// staff with registrations.sensitive, and every such list is written to the audit log.

export interface DoorListColumn {
  fieldId: string;
  label: string;
  sensitive: boolean;
}

export interface DoorListEntry {
  registrationId: string;
  name: string;
  email: string;
  partySize: number;
  source: RegistrationSource;
  /** Answers as text by field id; only with answers. */
  answers: Record<string, string>;
}

export interface DoorList {
  occurrenceId: string;
  eventId: string;
  columns: DoorListColumn[];
  entries: DoorListEntry[];
  totals: { registrations: number; people: number };
}

export async function doorList(
  tx: Tx, ctx: ActorContext, occurrenceId: string, opts: { answers?: boolean; locale?: string } = {},
): Promise<DoorList> {
  assertCan(ctx, "registrations.read");
  const occ = await tx.selectFrom("catalog.occurrence").select(["id", "event_id"]).where("id", "=", occurrenceId).executeTakeFirst();
  if (!occ) throw new DomainError("not_found", "Occurrence not found");
  const account = await getAccount(tx);
  const locale = opts.locale && account.locales.includes(opts.locale) ? opts.locale : account.defaultLocale;
  const rows = await tx.selectFrom("registration.registration")
    .select(["id", "name", "email", "party_size", "source"])
    .where("occurrence_id", "=", occurrenceId).where("status", "=", "confirmed").where("anonymised_at", "is", null)
    .execute();
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  rows.sort((a, b) => collator.compare(a.name ?? "", b.name ?? "") || a.id.localeCompare(b.id));

  const sensitiveOk = can(ctx, "registrations.sensitive");
  let fields: FormField[] = [];
  let answers = new Map<string, Record<string, unknown>>();
  if (opts.answers) {
    fields = (await answerFields(tx, occ.event_id)).filter((f) => sensitiveOk || !f.sensitive);
    answers = await readAnswers(tx, ctx.tenantId, rows.map((r) => r.id), { kind: "staff", ctx });
  }
  const columns = fields.map((f) => ({ fieldId: f.id, label: pickText(f.label, locale, account.defaultLocale), sensitive: f.sensitive }));
  const entries = rows.map((r) => ({
    registrationId: r.id, name: r.name ?? "", email: r.email ?? "", partySize: r.party_size, source: r.source,
    answers: Object.fromEntries(fields.map((f) => [f.id, answerText(f, answers.get(r.id)?.[f.id] as never, locale, account.defaultLocale)]).filter(([, v]) => v)),
  }));
  if (columns.some((c) => c.sensitive)) {
    await recordAudit(tx, ctx, { action: "registration.sensitive_listed", entityType: "occurrence", entityId: occurrenceId, diff: { registrations: entries.length } });
  }
  return {
    occurrenceId, eventId: occ.event_id, columns, entries,
    totals: { registrations: entries.length, people: entries.reduce((n, e) => n + e.partySize, 0) },
  };
}
