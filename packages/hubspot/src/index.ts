export * from "./client.js";
export { type FakeContact, FakeHubSpot, type FakeSend } from "./fake.js";
export { type OAuthState, signState, verifyState } from "./state.js";

// Scopes (docs/hubspot.md, "Scopes"). Optional ones are granted only on portals that have the
// product (custom behavioural events need Marketing Hub Enterprise); features follow from what
// the connection records as granted.
export const REQUIRED_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.lists.read",
  "crm.lists.write",
  "crm.objects.marketing_events.read",
  "crm.objects.marketing_events.write",
  "content",
  "marketing-email",
] as const;

/** Custom behavioural events (Marketing Hub Enterprise). */
export const BEHAVIOURAL_EVENT_SCOPES = ["analytics.behavioral_events.send", "behavioral_events.event_definitions.read_write"] as const;
/** Cleanup after HubSpot sending (docs/hubspot.md, "Cleanup after HubSpot sending"): subscription
 * types, and the workflow that sets contacts back to non-marketing. */
export const CLEANUP_SCOPES = [
  "communication_preferences.read_write",
  "communication_preferences.statuses.batch.read",
  "communication_preferences.statuses.batch.write",
  "automation",
] as const;
export const OPTIONAL_SCOPES = [...BEHAVIOURAL_EVENT_SCOPES, ...CLEANUP_SCOPES] as const;
