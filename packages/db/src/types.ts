import type { ColumnType, Generated } from "kysely";

// Hand-written until kysely-codegen runs in CI against a migrated database.
// Keep in sync with src/migrations.

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>;
/** Floating local wall time, "YYYY-MM-DDTHH:mm:ss" (Postgres timestamp without time zone). */
export type LocalDateTime = string;

export type Role = "owner" | "editor" | "event_manager" | "box_office" | "door_staff" | "finance";
export type ApiKeyKind = "publishable" | "preview" | "channel";

export interface AccountTable {
  id: string;
  tenant_id: ColumnType<string, never, never>;
  slug: string;
  name: string;
  default_timezone: Generated<string>;
  default_locale: Generated<string>;
  locales: Generated<string[]>;
  horizon_months: Generated<number>;
  anonymise_after_months: Generated<number>;
  sensitive_delete_after_days: Generated<number>;
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
  /** Channel keys only. */
  channel_id: string | null;
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
export type AdmissionMode = "none" | "external" | "registration" | "tickets";
export type AccessPolicy = "open" | "invite_only";
export type OccurrenceStatus = "scheduled" | "cancelled";
export type ValueSource = "default" | "rule" | "override";
export type EffectiveField = "location" | "tags" | "externalUrl" | "capacity" | "overbooking";
/** Fields resolved per target, e.g. per offer (docs/ticketing.md, "Prices"). */
export type TargetedField = "price" | "offerAvailable";

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
  access_policy: Generated<AccessPolicy>;
  listed: Generated<boolean>;
  capacity: number | null;
  overbooking_pct: Generated<number>;
  guest_allowed: Generated<boolean>;
  registration_opens_min: number | null;
  registration_closes_min: Generated<number>;
  waitlist_enabled: Generated<boolean>;
  claim_window_min: Generated<number>;
  waitlist_cutoff_min: Generated<number>;
  reminder_min_before: number | null;
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
  location_cleared: Generated<boolean>;
  external_url_cleared: Generated<boolean>;
  tags_override: string[] | null;
  capacity_override: number | null;
  access_policy_override: AccessPolicy | null;
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

export interface CapacityPoolTable {
  id: string;
  tenant_id: string;
  occurrence_id: string;
  capacity: number | null;
  overbooking_pct: Generated<number>;
  bookable_limit: ColumnType<number | null, never, never>;
  held: Generated<number>;
  taken: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface HoldTable {
  id: string;
  tenant_id: string;
  pool_id: string;
  quantity: number;
  expires_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export type RegistrationStatus = "confirmed" | "waitlisted" | "offered" | "cancelled";
export type RegistrationSource = "invitation" | "open" | "staff";
/** expired: a waitlist offer that was not claimed in time. */
export type CancelledBy = "attendee" | "staff" | "expired";
export type AdmissionStatus = "valid" | "void";

export interface RegistrationTable {
  id: string;
  tenant_id: string;
  event_id: string;
  occurrence_id: string;
  invitation_id: string | null;
  /** Null once anonymised. */
  name: string | null;
  email: string | null;
  locale: string;
  party_size: number;
  status: RegistrationStatus;
  source: RegistrationSource;
  /** Place in line while waitlisted or offered (from registration.waitlist_seq; not a rank). */
  waitlist_position: string | number | null;
  offer_hold_id: string | null;
  offer_expires_at: Timestamp | null;
  confirmed_at: Timestamp | null;
  token_version: Generated<number>;
  cancelled_at: Timestamp | null;
  cancelled_by: CancelledBy | null;
  reminded_at: Timestamp | null;
  form_version: number | null;
  sensitive_consent_at: Timestamp | null;
  anonymised_at: Timestamp | null;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type InvitationStatus = "pending" | "sent" | "accepted" | "declined";
export type SendKind = "invitation" | "reminder";
export type DeliveryStatus = "queued" | "sent" | "delivered" | "bounced" | "spam_complaint" | "failed";

export interface GuestInvitationTable {
  id: string;
  tenant_id: string;
  event_id: string;
  email: string;
  name: string | null;
  locale: string | null;
  guest_allowed: boolean | null;
  external_contact_id: string | null;
  status: Generated<InvitationStatus>;
  token_version: Generated<number>;
  first_sent_at: Timestamp | null;
  last_sent_at: Timestamp | null;
  responded_at: Timestamp | null;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface InvitationSendTable {
  id: string;
  tenant_id: string;
  invitation_id: string;
  kind: SendKind;
  requested_by: string | null;
  requested_at: GeneratedTimestamp;
  sent_at: Timestamp | null;
  message_id: string | null;
  delivery_status: Generated<DeliveryStatus>;
  delivery_detail: string | null;
  delivery_at: Timestamp | null;
}

export interface GuestImportTable {
  id: string;
  tenant_id: string;
  event_id: string;
  created_by: string | null;
  file_name: string;
  headers: string[];
  rows: ColumnType<string[][], string, string>;
  created_at: GeneratedTimestamp;
  expires_at: GeneratedTimestamp;
}

export interface ImportMappingTable {
  tenant_id: string;
  mapping: ColumnType<Record<string, string>, string, string>;
  updated_at: GeneratedTimestamp;
}

export interface FormVersionTable {
  tenant_id: string;
  event_id: string;
  version: number;
  fields: ColumnType<unknown[], string, never>;
  created_by: string | null;
  created_at: GeneratedTimestamp;
}

export interface AnswerTable {
  tenant_id: string;
  registration_id: string;
  field_id: string;
  value: Json;
}

export interface SensitiveAnswerTable {
  tenant_id: string;
  registration_id: string;
  field_id: string;
  ciphertext: Buffer;
  created_at: GeneratedTimestamp;
}

export interface DataKeyTable {
  tenant_id: string;
  wrapped: Buffer;
  master_key_id: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type IntegrationProvider = "hubspot";
export type ConnectionStatus = "active" | "needs_reconnect" | "disconnected";

export interface ConnectionTable {
  id: string;
  tenant_id: string;
  provider: IntegrationProvider;
  status: ConnectionStatus;
  external_account_id: string;
  scopes: ColumnType<string[], string[] | undefined, string[]>;
  settings: ColumnType<unknown, string | undefined, string>;
  setup_status: ColumnType<"pending" | "done" | "failed", "pending" | "done" | "failed" | undefined, "pending" | "done" | "failed">;
  setup_error: string | null;
  setup_at: Timestamp | null;
  status_reason: string | null;
  connected_by: string | null;
  connected_at: Timestamp;
  generation: Generated<number>;
  disconnected_at: Timestamp | null;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface CredentialTable {
  connection_id: string;
  tenant_id: string;
  ciphertext: Buffer;
  access_expires_at: Timestamp;
  updated_at: GeneratedTimestamp;
}

export interface TokenKeyTable {
  tenant_id: string;
  key: Buffer;
  created_at: GeneratedTimestamp;
}

export interface AdmissionTable {
  id: string;
  tenant_id: string;
  /** Exactly one of registration_id and ticket_id is set. */
  registration_id: string | null;
  ticket_id: string | null;
  occurrence_id: string;
  party_size: number;
  status: Generated<AdmissionStatus>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
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
  target_group: string | null;
  value: Json;
}

export type OfferStatus = "active" | "archived";

export interface VatClassTable {
  id: string;
  tenant_id: string;
  code: string;
  label: string;
  /** numeric(5,2); pg returns it as a string. */
  rate_pct: ColumnType<string, string | number, string | number>;
  archived_at: Timestamp | null;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface OfferTable {
  id: string;
  tenant_id: string;
  event_id: string;
  code: string;
  vat_class_id: string;
  sort_order: Generated<number>;
  status: Generated<OfferStatus>;
  places_per_unit: Generated<number>;
  min_per_reservation: Generated<number>;
  max_per_reservation: Generated<number>;
  default_price: number;
  on_sale_min_before: number | null;
  on_sale_at: Timestamp | null;
  off_sale_min_before: number | null;
  off_sale_at: Timestamp | null;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface OfferTranslationTable {
  tenant_id: string;
  offer_id: string;
  locale: string;
  name: string;
  description: string | null;
}

export interface OfferOverrideTable {
  tenant_id: string;
  offer_id: string;
  occurrence_id: string;
  amount: number | null;
  available: boolean | null;
}

export interface EffectivePriceTable {
  tenant_id: string;
  occurrence_id: string;
  offer_id: string;
  amount: number;
  amount_source: ValueSource;
  amount_rule_id: string | null;
  available: boolean;
  available_source: ValueSource;
  available_rule_id: string | null;
}

export type ChannelKind = "ecom" | "pos";

export interface SalesChannelTable {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  kind: ChannelKind;
  hold_minutes: Generated<number>;
  send_tickets: Generated<boolean>;
  active: Generated<boolean>;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface SkuMappingTable {
  tenant_id: string;
  vat_class_id: string;
  channel_id: string;
  external_sku: string;
  updated_at: GeneratedTimestamp;
}

export interface OfferChannelTable {
  tenant_id: string;
  offer_id: string;
  channel_id: string;
}

export interface UserGroupTable {
  id: string;
  tenant_id: string;
  code: string;
  names: ColumnType<Record<string, string>, string | undefined, string>;
  sort_order: Generated<number>;
  archived_at: Timestamp | null;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface EventAccessGroupTable {
  tenant_id: string;
  event_id: string;
  group_id: string;
}

export interface OfferAccessGroupTable {
  tenant_id: string;
  offer_id: string;
  group_id: string;
}

export interface OfferGroupPriceTable {
  tenant_id: string;
  offer_id: string;
  group_id: string;
  amount: number;
}

export interface OfferGroupOverrideTable {
  tenant_id: string;
  offer_id: string;
  occurrence_id: string;
  group_id: string;
  amount: number;
}

export interface EffectiveGroupPriceTable {
  tenant_id: string;
  occurrence_id: string;
  offer_id: string;
  group_id: string;
  amount: number;
  amount_source: ValueSource;
  amount_rule_id: string | null;
}

export type ReservationStatus = "held" | "confirmed" | "cancelled" | "expired";
export type TicketStatus = "valid" | "cancelled";
export type TicketCancelledBy = "channel" | "staff";

export interface ReservationTable {
  id: string;
  tenant_id: string;
  channel_id: string;
  status: Generated<ReservationStatus>;
  expires_at: Timestamp;
  external_ref: string | null;
  external_order_ref: string | null;
  locale: string;
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_locale: string | null;
  confirmed_at: Timestamp | null;
  cancelled_at: Timestamp | null;
  expired_at: Timestamp | null;
  anonymised_at: Timestamp | null;
  group_id: string | null;
  group_code: string | null;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ReservationLineTable {
  id: string;
  tenant_id: string;
  reservation_id: string;
  line_no: number;
  occurrence_id: string;
  offer_id: string;
  quantity: number;
  places_per_unit: number;
  offer_code: string;
  unit_price: number;
  currency: string;
  vat_class_code: string;
  /** numeric(5,2); pg returns it as a string. */
  vat_rate_pct: ColumnType<string, string | number, string | number>;
  external_sku: string;
  line_name: string;
  occurrence_start_utc: Timestamp;
  timezone: string;
  location_name: string | null;
  group_code: string | null;
}

export interface ReservationHoldTable {
  tenant_id: string;
  reservation_id: string;
  occurrence_id: string;
  hold_id: string;
  places: number;
}

export interface TicketTable {
  id: string;
  tenant_id: string;
  reservation_id: string;
  line_id: string;
  occurrence_id: string;
  offer_id: string;
  status: Generated<TicketStatus>;
  token_version: Generated<number>;
  cancelled_at: Timestamp | null;
  cancelled_by: TicketCancelledBy | null;
  external_refund_ref: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
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
  "catalog.user_group": UserGroupTable;
  "catalog.event_access_group": EventAccessGroupTable;
  "rules.effective_value": EffectiveValueTable;
  "rules.rule": RuleTable;
  "rules.rule_effect": RuleEffectTable;
  "inventory.capacity_pool": CapacityPoolTable;
  "inventory.hold": HoldTable;
  "registration.registration": RegistrationTable;
  "registration.token_key": TokenKeyTable;
  "registration.guest_invitation": GuestInvitationTable;
  "registration.invitation_send": InvitationSendTable;
  "registration.guest_import": GuestImportTable;
  "registration.import_mapping": ImportMappingTable;
  "registration.form_version": FormVersionTable;
  "registration.answer": AnswerTable;
  "registration.sensitive_answer": SensitiveAnswerTable;
  "admission.admission": AdmissionTable;
  "offers.vat_class": VatClassTable;
  "offers.offer": OfferTable;
  "offers.offer_translation": OfferTranslationTable;
  "offers.offer_override": OfferOverrideTable;
  "offers.effective_price": EffectivePriceTable;
  "offers.sales_channel": SalesChannelTable;
  "offers.sku_mapping": SkuMappingTable;
  "offers.offer_channel": OfferChannelTable;
  "offers.offer_access_group": OfferAccessGroupTable;
  "offers.offer_group_price": OfferGroupPriceTable;
  "offers.offer_group_override": OfferGroupOverrideTable;
  "offers.effective_group_price": EffectiveGroupPriceTable;
  "sales.reservation": ReservationTable;
  "sales.reservation_line": ReservationLineTable;
  "sales.reservation_hold": ReservationHoldTable;
  "sales.ticket": TicketTable;
  "tenancy.account": AccountTable;
  "tenancy.user": UserTable;
  "tenancy.membership": MembershipTable;
  "tenancy.invitation": InvitationTable;
  "tenancy.audit_log": AuditLogTable;
  "tenancy.api_key": ApiKeyTable;
  "outbox.event": OutboxEventTable;
  "outbox.handled": OutboxHandledTable;
  "platform.data_key": DataKeyTable;
  "integrations.connection": ConnectionTable;
  "integrations.credential": CredentialTable;
}
