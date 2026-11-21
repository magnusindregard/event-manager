export * from "./client.js";
export { FakeHubSpot } from "./fake.js";
export { type OAuthState, signState, verifyState } from "./state.js";

// Scopes (docs/hubspot.md, "Scopes"). Optional ones are granted only on portals that have the
// product (custom behavioural events need Marketing Hub Enterprise); features follow from what
// the connection records as granted.
export const REQUIRED_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.schemas.contacts.write",
  "crm.lists.read",
  "crm.lists.write",
  "crm.objects.marketing_events.read",
  "crm.objects.marketing_events.write",
  "content",
  "marketing-email",
] as const;

export const OPTIONAL_SCOPES = ["analytics.behavioral_events.send", "behavioral_events.event_definitions.read_write"] as const;

/** What the portal set up in milestone 1 consists of (docs/hubspot.md, "Setup in the portal"). */
export const PROPERTY_GROUP = { name: "event_manager", label: "Event manager" } as const;
export const GUEST_KEY_PROPERTY = {
  name: "em_guest_key",
  label: "Event manager guest key",
  description: "Written by the event manager. Personalises invitation links in HubSpot emails; do not edit.",
  groupName: PROPERTY_GROUP.name,
} as const;
