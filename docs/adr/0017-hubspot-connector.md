# 0017 – HubSpot connector: our OAuth app, a guest key per contact, emails drafted by the platform

**Status:** Proposed · 2026-11-20 · Builds on [0008](0008-events-and-webhooks.md) and [0010](0010-buy-not-build.md)

## Context

Epic #9 pushes what happens in the platform to the client's marketing stack, and ADR 0008 names HubSpot as a connector run in the platform. Clients already export guest lists from HubSpot, and some want their invitations to come from HubSpot, in their own design, with HubSpot's reporting. The platform already sends every guest email through Postmark and is the source of truth for invitations and RSVPs.

Things in HubSpot that shape the design:

- An app installed in several portals must use OAuth. A developer platform app with private distribution can be installed in up to 10 portals without marketplace review.
- A marketing email can only personalise with the recipient's own properties, and a contact property holds one value.
- Emails can be cloned and their drafts edited through the API on any plan; publishing or sending a regular email through the API needs Marketing Hub Enterprise (or the transactional email add-on).
- Marketing events with register, attend and cancel work on every plan. Custom behavioural events need Enterprise.

## Decision

- **Our own HubSpot app with OAuth**, private distribution to start, marketplace later. Not a guide for clients to create their own token app. Tokens are encrypted with the account's data key; the app's secret lives in Key Vault.
- **Per event, the client chooses who sends invitations and reminders**: the platform (default) or HubSpot. Transactional emails (confirmation with QR, changes, cancellations, waitlist) always come from the platform.
- **HubSpot emails are regular emails drafted by the platform**: it clones a template email the client chose, sets name, subject, preview text and recipients, and puts in the event's links. Design and body copy are edited in HubSpot. On Enterprise portals the platform sends or schedules them through the API; on other plans the manager sends them in HubSpot. No workflows.
- **No per-event data on contacts.** Each contact gets one **guest key** (`em_guest_key`), a signed token per account and contact. The personal link is `/h/<eventId>/{{ contact.em_guest_key }}`: the event comes from the draft, the secret from the contact, so a contact can be invited to several events at once.
- **Audiences are static segments the platform owns**, one set per event (invitation recipients, awaiting reply, confirmed per occurrence), updated on every RSVP and **reconciled with the platform before every send**.
- **Mirroring**: contacts (name, email, locale, guest key), one marketing event per occurrence with attendance, and custom behavioural events when the portal has Enterprise.
- **Inbound only for guest lists**: a HubSpot list can be imported as a guest list with the existing import rules. HubSpot never changes a registration.
- A new **`integrations` module** holds connections, credentials, id mappings and the delivery log; outgoing webhooks (#94) use the same log.

Details: [docs/hubspot.md](../hubspot.md).

## Consequences

- We run an OAuth backend and own an app in HubSpot's developer platform: token refresh, revoked installs, scope changes and HubSpot API versions are ours to follow. Past 10 portals we need marketplace certification.
- The full "send from the platform" experience needs Marketing Hub Enterprise. Other plans get drafts and segments, and the manager clicks send in HubSpot; the platform learns about the send by polling.
- The guest key is a long-lived secret stored in the client's CRM, where anyone with contact access can read it. It only opens invitations the platform holds for that contact, it can be rotated, and it dies with the connection. That is the price of personalised links without per-event properties.
- Segment membership is a copy that can drift; correctness rests on the reconcile before each send, not on the incremental updates.
- Templates must contain our placeholders. A template without them makes a draft with no personal link, so the platform checks and warns.
- Platform anonymisation does not reach HubSpot; the client's own retention applies there.
- Envelope encryption moves from the `registration` module to `shared`, so a second module can use it.
