import { type AdmissionStatus, newId, type Tx } from "@event-manager/db";

// Admissions (docs/registration.md, "Admission"): one per registration, created when it is
// confirmed. The party size lives here, so a validator can later admit "2 of 2". There is no
// scanning yet; the scan log arrives with the validator app.

export interface Admission {
  id: string;
  registrationId: string;
  occurrenceId: string;
  partySize: number;
  status: AdmissionStatus;
}

const toAdmission = (r: { id: string; registration_id: string; occurrence_id: string; party_size: number; status: AdmissionStatus }): Admission => ({
  id: r.id, registrationId: r.registration_id, occurrenceId: r.occurrence_id, partySize: r.party_size, status: r.status,
});

/** Issues the admission for a confirmed registration, or makes its existing one valid again. */
export async function issueAdmission(tx: Tx, tenantId: string, registrationId: string, occurrenceId: string, partySize: number): Promise<Admission> {
  const row = await tx
    .insertInto("admission.admission")
    .values({ id: newId(), tenant_id: tenantId, registration_id: registrationId, occurrence_id: occurrenceId, party_size: partySize })
    .onConflict((oc) => oc.column("registration_id").doUpdateSet({ party_size: partySize, occurrence_id: occurrenceId, status: "valid" }))
    .returning(["id", "registration_id", "occurrence_id", "party_size", "status"])
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
    .select(["id", "registration_id", "occurrence_id", "party_size", "status"])
    .where("registration_id", "=", registrationId)
    .executeTakeFirst();
  return row ? toAdmission(row) : null;
}

export async function getAdmission(tx: Tx, id: string): Promise<Admission | null> {
  const row = await tx.selectFrom("admission.admission").select(["id", "registration_id", "occurrence_id", "party_size", "status"]).where("id", "=", id).executeTakeFirst();
  return row ? toAdmission(row) : null;
}
