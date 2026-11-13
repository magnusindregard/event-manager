import type { ColumnType, Generated } from "kysely";

// Hand-written until kysely-codegen runs in CI against a migrated database.
// Keep in sync with src/migrations.

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>;

export type Role = "owner" | "editor" | "event_manager" | "box_office" | "door_staff" | "finance";
export type ApiKeyKind = "publishable" | "preview";

export interface AccountTable {
  id: string;
  tenant_id: ColumnType<string, never, never>;
  slug: string;
  name: string;
  default_timezone: Generated<string>;
  default_locale: Generated<string>;
  locales: Generated<string[]>;
  horizon_months: Generated<number>;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface UserTable {
  id: string;
  idp_issuer: string;
  idp_subject: string;
  email: string;
  name: string | null;
  created_at: GeneratedTimestamp;
  last_login_at: Timestamp | null;
}

export interface MembershipTable {
  id: string;
  tenant_id: string;
  user_id: string;
  role: Role;
  scope_type: "venue" | "event" | null;
  scope_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface InvitationTable {
  id: string;
  tenant_id: string;
  email: string;
  role: Role;
  invited_by: string | null;
  created_at: GeneratedTimestamp;
  accepted_at: Timestamp | null;
}

export interface AuditLogTable {
  id: string;
  tenant_id: string;
  actor_user_id: string | null;
  actor_client_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  diff: Json;
  at: GeneratedTimestamp;
}

export interface ApiKeyTable {
  id: string;
  tenant_id: string;
  kind: ApiKeyKind;
  prefix: string;
  secret_hash: string;
  label: string;
  created_at: GeneratedTimestamp;
  revoked_at: Timestamp | null;
}

export interface OutboxEventTable {
  id: string;
  tenant_id: string;
  type: string;
  source: string;
  subject: string;
  data: Json;
  created_at: GeneratedTimestamp;
  dispatched_at: Timestamp | null;
}

export interface OutboxHandledTable {
  handler: string;
  event_id: string;
  tenant_id: string;
  handled_at: GeneratedTimestamp;
}

export interface DB {
  "tenancy.account": AccountTable;
  "tenancy.user": UserTable;
  "tenancy.membership": MembershipTable;
  "tenancy.invitation": InvitationTable;
  "tenancy.audit_log": AuditLogTable;
  "tenancy.api_key": ApiKeyTable;
  "outbox.event": OutboxEventTable;
  "outbox.handled": OutboxHandledTable;
}
