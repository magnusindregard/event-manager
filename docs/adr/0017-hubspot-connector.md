# 0017 – HubSpot connector: our OAuth app, invitations through HubSpot's single-send API, and cleanup of the contacts it makes marketing

**Status:** Proposed · 2026-11-20, revised 2026-11-24 after the spike · Builds on [0008](0008-events-and-webhooks.md) and [0010](0010-buy-not-build.md)

## Context

Epic #9 pushes what happens in the platform to the client's marketing stack, and ADR 0008 names HubSpot as a connector run in the platform. Clients already export guest lists from HubSpot, and some want their invitations to come from HubSpot, in their own design, with HubSpot's reporting. The platform already sends every guest email through its own email provider and is the source of truth for invitations and RSVPs.

The first version of this ADR had the platform draft HubSpot regular emails for static segments and publish them, with a per-contact guest key for the personal link. The spike (docs/hubspot.md, runs 1–16) showed what HubSpot actually does:

- An app installed in several portals must use OAuth. A developer platform app with private distribution can be installed in up to 10 portals without marketplace review. Optional scopes are locked until a portal admin allows them for the app.
- **HubSpot only delivers marketing email to marketing contacts, and an app cannot make a contact one** (runs 5–6). Regular emails to our guests were suppressed until someone set them as marketing by hand.
- The **marketing single-send API** sends a single-send email to one recipient per call, with per-send values as `{{ custom.<name> }}`, and **makes every recipient a marketing contact by itself**: even a send HubSpot then refuses (runs 7–14). It needs Marketing Hub Enterprise. A clone of a single-send email stays one, must be published before it sends, and personalises a link per send. A repeated `sendId` is ignored. Plus addresses are refused with `VALIDATION_FAILED`.
- Marketing status cannot be set through the API: a `PATCH` answers `200` and changes nothing (run 15). A workflow action can set it, the app can create that workflow through the automation API (run 16), and a change to non-marketing takes effect at the portal's next update date. A marketing contact is billed for the period it was marketing in.
- Every marketing email has a subscription type, and a contact unsubscribed from a type does not get emails of that type. The app can unsubscribe a contact from a type and set it back to `NOT_SPECIFIED`, but can never re-subscribe anyone (runs 15–16).
- Marketing events with register, attend and cancel work on every plan. Custom behavioural events need Enterprise.

So sending through HubSpot means putting guests into the client's portal as billable marketing contacts, many of whom (lenders, the artist's family, other museums) have nothing to do with the client's marketing.

## Decision

- **Our own HubSpot app with OAuth**, private distribution to start, marketplace later. Tokens are encrypted with the account's data key; the app's secret lives in Key Vault. Subscription and automation scopes are optional, and features follow from what was granted.
- **Per event, the client chooses who sends invitations and reminders**: the platform (default) or HubSpot, offered only when the portal has Enterprise and the cleanup scopes. Transactional emails (confirmation with QR, changes, cancellations, waitlist) always come from the platform.
- **HubSpot sending is the single-send API, one call per guest.** The account picks a single-send template email per kind; the platform clones it per event, puts the event's link into it and publishes it. Each guest's send carries the platform's own invitation token as a custom property, so the link is `<attendee host>/i/{{ custom.invitation_token }}`. The platform times every send itself (invitations, reminders, the reminder before the event), uses the invitation send's id as `sendId`, and records HubSpot's result per guest. A guest HubSpot refuses (a plus address, unsubscribed, bounced) gets the platform's own email instead.
- **No guest key and no per-event data on contacts.** The invitation token lives only in the single send; HubSpot does not store custom properties.
- **The platform cleans up after itself.** Before a contact's first HubSpot send it records whether it created the contact, whether the contact was already marketing, and its subscription statuses. While the contact is marketing because of us, it is unsubscribed from every subscription type except the account's own event type, so it gets no other marketing from the portal. When the platform no longer needs it (the end of its last event through HubSpot, plus a grace period), the platform **deletes contacts it created** (unless the client has taken them into use) and, for contacts it **turned into marketing contacts**, puts the subscription statuses back and sets them to non-marketing through a workflow it creates in the portal. Contacts that were marketing before are never touched.
- **Segments are for the client's own use**, not for sending: per event (awaiting reply, confirmed per occurrence), kept in step on every RSVP, plus `EM · Temporary marketing contacts` and `EM · Set to non-marketing` for the cleanup.
- **Mirroring**: contacts (name, email, locale), one marketing event per occurrence with attendance, and custom behavioural events when the portal has Enterprise.
- **Inbound only for guest lists**: a HubSpot list can be imported as a guest list with the existing import rules. HubSpot never changes a registration.
- A new **`integrations` module** holds connections, credentials, id mappings, what the platform did to each contact, and the delivery log; outgoing webhooks (#94) use the same log.

Details: [docs/hubspot.md](../hubspot.md), "Cleanup after HubSpot sending" and the spike results.

### Alternatives considered

- **Regular emails drafted by the platform for segments** (this ADR's first version): reaches only guests who are already marketing contacts, needs a guest key stored in the CRM, segment reconciles before every send, and polling on non-Enterprise portals.
- **A client workflow that makes our contacts marketing**, with regular emails: the same billing and data protection cost as single-send, but relying on workflows the platform cannot see.
- **Split per recipient** (HubSpot for existing marketing contacts, the platform for the rest): two senders and two designs for one invitation. Single-send's fallback keeps this only for guests HubSpot refuses.
- **No HubSpot sending** (platform templates for all invitations, HubSpot for mirroring only): no marketing contact cost at all, but clients lose HubSpot's designer and reporting for invitations. It remains the default channel, and the only one on portals without Enterprise.

## Consequences

- We run an OAuth backend and own an app in HubSpot's developer platform: token refresh, revoked installs, scope changes and HubSpot API versions are ours to follow. Past 10 portals we need marketplace certification.
- **Every guest invited through HubSpot costs the client a marketing contact** for at least the rest of that billing period, and a large invitation can raise the portal's tier until renewal. The cleanup stops the count from growing; it cannot undo the current period. The admin shows the number of guests who would become marketing contacts before anything is sent.
- HubSpot sending needs Marketing Hub Enterprise and a portal admin's approval of the optional scopes. Other portals get mirroring, segments and list import, and the platform sends the invitations.
- The cleanup depends on what the platform recorded before its first send, and on a workflow in the portal that someone could switch off; "Repair setup" restores it and the connection page warns when the segment does not empty itself.
- Subscription types are shared with the client's marketing. The account must keep one type for event emails only; the platform warns when other emails use it, and re-checks for new types every night.
- Deleting contacts we created removes their HubSpot history, including the marketing event attendance we wrote; the platform's own registrations are unaffected.
- Guests with a plus address are always sent by the platform.
- Platform anonymisation does not reach contacts the client has kept; the client's own retention applies there.
- Envelope encryption moves from the `registration` module to `shared`, so a second module can use it.
