import type { ColumnType, Generated } from "kysely";

// Hand-written until kysely-codegen runs in CI against a migrated database.
// Keep in sync with src/migrations.

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>;
/** Floating local wall time, "YYYY-MM-DDTHH:mm:ss" (Postgres timestamp without time zone). */
export type LocalDateTime = string;

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
  signin_kind: Generated<SigninKind>;
  provision_status: Generated<ProvisionStatus>;
  provisioned_kind: "work" | "local" | null;
  entra_object_id: string | null;
  provision_error: string | null;
  provision_attempts: Generated<number>;
  provisioned_at: Timestamp | null;
  email_sent_at: Timestamp | null;
}

export type SigninKind = "auto" | "work" | "local";
export type ProvisionStatus = "pending" | "provisioned" | "failed";

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

export interface TagVocabularyTable {
  id: string;
  tenant_id: string;
  key: string;
  labels: ColumnType<Record<string, string>, string | undefined, string>;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
}

export interface TagTable {
  id: string;
  tenant_id: string;
  vocabulary_id: string;
  key: string;
  labels: ColumnType<Record<string, string>, string | undefined, string>;
  archived_at: Timestamp | null;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
}

export interface IdempotencyKeyTable {
  tenant_id: string;
  key: string;
  request_hash: string;
  status_code: number;
  response: Json;
  created_at: GeneratedTimestamp;
}

export type LocationKind = "venue" | "space";
export type EventStatus = "draft" | "published" | "cancelled" | "archived";
export type AdmissionMode = "none" | "external";
export type OccurrenceStatus = "scheduled" | "cancelled";
export type ValueSource = "default" | "rule" | "override";
export type EffectiveField = "location" | "tags" | "externalUrl";

export interface LocationTable {
  id: string;
  tenant_id: string;
  kind: LocationKind;
  parent_id: string | null;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  archived_at: Timestamp | null;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface EventTable {
  id: string;
  tenant_id: string;
  slug: string;
  status: Generated<EventStatus>;
  timezone: string;
  default_location_id: string | null;
  default_duration_min: Generated<number>;
  admission_mode: Generated<AdmissionMode>;
  external_url: string | null;
  external_refs: ColumnType<Record<string, string>, string | undefined, string>;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface EventTranslationTable {
  tenant_id: string;
  event_id: string;
  locale: string;
  title: string;
  short_description: string | null;
  image_url: string | null;
  image_alt: string | null;
}

export interface EventTagTable {
  tenant_id: string;
  event_id: string;
  tag_id: string;
}

export interface OccurrenceTable {
  id: string;
  tenant_id: string;
  event_id: string;
  series_id: string | null;
  recurrence_id_local: LocalDateTime | null;
  start_utc: Timestamp;
  end_utc: Timestamp;
  status: Generated<OccurrenceStatus>;
  detached: Generated<boolean>;
  location_override_id: string | null;
  external_url_override: string | null;
  tags_override: string[] | null;
  resolved_version: number | null;
  conflict: Generated<boolean>;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface SeriesTable {
  id: string;
  tenant_id: string;
  event_id: string;
  rrule: string;
  dtstart_local: LocalDateTime;
  duration_min: number;
  timezone: string;
  exdates: ColumnType<LocalDateTime[], LocalDateTime[] | undefined, LocalDateTime[]>;
  generated_until: Timestamp;
  complete: Generated<boolean>;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface EffectiveValueTable {
  tenant_id: string;
  occurrence_id: string;
  field: EffectiveField;
  value: Json;
  source: ValueSource;
  rule_id: string | null;
}

/** Calendar date "YYYY-MM-DD" (Postgres date). */
export type LocalDate = string;
/** Wall-clock time "HH:mm:ss" (Postgres time). */
export type LocalTime = string;

export interface RuleTable {
  id: string;
  tenant_id: string;
  event_id: string;
  name: string;
  priority: Generated<number>;
  date_from: LocalDate | null;
  date_to: LocalDate | null;
  weekdays: number[] | null;
  start_time_from: LocalTime | null;
  start_time_to: LocalTime | null;
  active: Generated<boolean>;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface RuleEffectTable {
  id: string;
  tenant_id: string;
  rule_id: string;
  effect_type: string;
  target_ref: string | null;
  value: Json;
}

export interface DB {
  "tenancy.tag_vocabulary": TagVocabularyTable;
  "tenancy.tag": TagTable;
  "tenancy.idempotency_key": IdempotencyKeyTable;
  "catalog.location": LocationTable;
  "catalog.event": EventTable;
  "catalog.event_translation": EventTranslationTable;
  "catalog.event_tag": EventTagTable;
  "catalog.occurrence": OccurrenceTable;
  "catalog.series": SeriesTable;
  "rules.effective_value": EffectiveValueTable;
  "rules.rule": RuleTable;
  "rules.rule_effect": RuleEffectTable;
  "tenancy.account": AccountTable;
  "tenancy.user": UserTable;
  "tenancy.membership": MembershipTable;
  "tenancy.invitation": InvitationTable;
  "tenancy.audit_log": AuditLogTable;
  "tenancy.api_key": ApiKeyTable;
  "outbox.event": OutboxEventTable;
  "outbox.handled": OutboxHandledTable;
}
