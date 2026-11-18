import { type Kysely, sql } from "kysely";

// Accepted invitations are kept as history, so uniqueness applies to pending invitations only:
// a member who was removed can be invited to the same role again.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE tenancy.invitation DROP CONSTRAINT invitation_tenant_id_email_role_key;
    CREATE UNIQUE INDEX invitation_pending ON tenancy.invitation (tenant_id, email, role) WHERE accepted_at IS NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX tenancy.invitation_pending;
    DELETE FROM tenancy.invitation i USING tenancy.invitation newer
     WHERE i.tenant_id = newer.tenant_id AND i.email = newer.email AND i.role = newer.role AND i.created_at < newer.created_at;
    ALTER TABLE tenancy.invitation ADD CONSTRAINT invitation_tenant_id_email_role_key UNIQUE (tenant_id, email, role);
  `.execute(db);
}
