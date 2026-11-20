import { type AdmissionStatus, newId, type Tx } from "@event-manager/db";

// Admissions (docs/registration.md, "Admission"): one per registration, created when it is
// confirmed, and one per ticket (docs/ticketing.md, "Ticket and admission"). The party size
// lives here, so a validator can later admit "2 of 2" or a family ticket of four. There is no
// scanning yet; the scan log arrives with the validator app.

export interface Admission {
  id: string;
  /** Exactly one of registrationId and ticketId is set. */
  registrationId: string | null;
  ticketId: string | null;
  occurrenceId: string;
  partySize: number;
  status: AdmissionStatus;
}

const columns = ["id", "registration_id", "ticket_id", "occurrence_id", "party_size", "status"] as const;
type Row = { id: string; registration_id: string | null; ticket_id: string | null; occurrence_id: string; party_size: number; status: AdmissionStatus };
const toAdmission = (r: Row): Admission => ({
  id: r.id, registrationId: r.registration_id, ticketId: r.ticket_id, occurrenceId: r.occurrence_id, partySize: r.party_size, status: r.status,
});

/** Issues the admission for a confirmed registration, or makes its existing one valid again. */
export async function issueAdmission(tx: Tx, tenantId: string, registrationId: string, occurrenceId: string, partySize: number): Promise<Admission> {
  const row = await tx
    .insertInto("admission.admission")
    .values({ id: newId(), tenant_id: tenantId, registration_id: registrationId, occurrence_id: occurrenceId, party_size: partySize })
    .onConflict((oc) => oc.column("registration_id").doUpdateSet({ party_size: partySize, occurrence_id: occurrenceId, status: "valid" }))
    .returning(columns)
    .executeTakeFirstOrThrow();
  return toAdmission(row);
}

export async function setAdmissionPartySize(tx: Tx, registrationId: string, partySize: number): Promise<void> {
  await tx.updateTable("admission.admission").set({ party_size: partySize }).where("registration_id", "=", registrationId).execute();
}

/** A cancelled registration's admission no longer admits anyone. */
export async function voidAdmission(tx: Tx, registrationId: string): Promise<void> {
  await tx.updateTable("admission.admission").set({ status: "void" }).where("registration_id", "=", registrationId).execute();
}

export async function admissionFor(tx: Tx, registrationId: string): Promise<Admission | null> {
  const row = await tx
    .selectFrom("admission.admission")
    .select(columns)
    .where("registration_id", "=", registrationId)
    .executeTakeFirst();
  return row ? toAdmission(row) : null;
}

export async function getAdmission(tx: Tx, id: string): Promise<Admission | null> {
  const row = await tx.selectFrom("admission.admission").select(columns).where("id", "=", id).executeTakeFirst();
  return row ? toAdmission(row) : null;
}

// ── Tickets ──────────────────────────────────────────────────────────────────

/** Issues the admissions of new tickets, one each. Returns them by ticket id. */
export async function issueTicketAdmissions(
  tx: Tx, tenantId: string, tickets: readonly { ticketId: string; occurrenceId: string; partySize: number }[],
): Promise<Map<string, Admission>> {
  const out = new Map<string, Admission>();
  for (let i = 0; i < tickets.length; i += 1000) {
    const rows = await tx
      .insertInto("admission.admission")
      .values(tickets.slice(i, i + 1000).map((t) => ({ id: newId(), tenant_id: tenantId, ticket_id: t.ticketId, occurrence_id: t.occurrenceId, party_size: t.partySize })))
      .returning(columns)
      .execute();
    for (const r of rows) out.set(r.ticket_id!, toAdmission(r));
  }
  return out;
}

export async function ticketAdmissions(tx: Tx, ticketIds: readonly string[]): Promise<Map<string, Admission>> {
  const out = new Map<string, Admission>();
  for (let i = 0; i < ticketIds.length; i += 1000) {
    const rows = await tx.selectFrom("admission.admission").select(columns).where("ticket_id", "in", ticketIds.slice(i, i + 1000)).execute();
    for (const r of rows) out.set(r.ticket_id!, toAdmission(r));
  }
  return out;
}
