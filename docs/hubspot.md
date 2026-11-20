# HubSpot connector

*Draft, 20 November 2026. Issue #95, part of epic #9. Builds on [docs/registration.md](registration.md). Decisions: [ADR 0017](adr/0017-hubspot-connector.md), [ADR 0008](adr/0008-events-and-webhooks.md).*

## Goal

Let an account connect its HubSpot portal, so that:

- **contacts, events and attendance show up in HubSpot**, for segmentation, reporting and the contact timeline;
- an event can have its **invitations and reminders sent as HubSpot marketing emails**. The platform makes the drafts from the client's own template email and keeps the recipients up to date. The platform keeps sending the transactional emails;
- a **HubSpot list can be the source of an event's guest list**, instead of a CSV exported from HubSpot.

The platform stays the source of truth for invitations, RSVPs and registrations. HubSpot gets copies and audiences; nothing in HubSpot changes a registration.

## Scope

### In

- **Connection**: our own HubSpot app, OAuth, one portal per account, connect and disconnect from the admin.
- **Contacts**: upsert of invited guests and (if the account opts in) open-registration attendees, with name, email, locale and a **guest key**.
- **Marketing events**: one per occurrence, with attendance (registered, cancelled, attended).
- **Segments**: static segments per event that the platform keeps in step with RSVPs.
- **HubSpot emails**: per event, invitations, invitation reminders and the reminder before the event can be HubSpot regular emails. The platform drafts them from a template and sends or schedules them through the API.
- **Guest list import from a HubSpot list**, with the existing import and re-import rules.
- **Custom behavioural events** for portals on Marketing Hub Enterprise.
- Sync log in the admin, with retries, dead letter and replay.

### Out, and how this prepares for it

| Out of scope | Prepared by |
|---|---|
| Marketplace listing | The app is a developer platform project app; private distribution now (up to 10 portals), switch distribution to marketplace and certify when we pass that |
| Workflows and automated emails | Segments and custom events are what a client's own workflow would enrol on; nothing in our design needs one |
| Transactional emails from HubSpot (confirmation with QR, changes, cancels) | They stay in the platform (ADR 0010); the account's own template comes with #100 |
| Live sync of a guest list from a HubSpot list | "Refresh from HubSpot" re-runs the import; the list is remembered on the event |
| Anything flowing from HubSpot into registrations | RSVPs only happen on our pages; HubSpot never writes back |
| Deleting contacts in HubSpot when we anonymise | The client is the controller of their portal; documented in the setup guide |
| Companies, deals, tickets | Contacts only |

## Connecting

### The app

We own one HubSpot app on HubSpot's developer platform (built and deployed with the HubSpot CLI, kept in `integrations/hubspot-app/`). Distribution is **private**: HubSpot lets such an app be installed in up to 10 portals without marketplace review. The app's client id and secret are platform secrets in Key Vault.

### OAuth

1. Settings → Integrations → **Connect HubSpot** (owner only). The API redirects to HubSpot's install URL with a signed `state` holding the account, the user and an expiry.
2. The portal admin picks the portal and approves the scopes.
3. HubSpot redirects to `GET /integrations/hubspot/callback`. The API checks `state`, exchanges the code, stores the refresh and access token encrypted, and records the portal id and the scopes granted.
4. A setup job creates what we need in the portal (below) and a backfill starts.

**Disconnect** deletes our tokens and mappings and stops all sync. What we wrote to HubSpot stays there. Guest keys stop working, so HubSpot email links already sent lead to "link not valid"; the personal links from the platform's own emails keep working.

A token HubSpot refuses (app uninstalled, access revoked) sets the connection to `needs_reconnect`: sync pauses, nothing is dropped, and the admin shows a banner.

### Scopes

| Scope | For | Required |
|---|---|---|
| `oauth` | Install | Yes |
| `crm.objects.contacts.read`, `crm.objects.contacts.write` | Contacts | Yes |
| `crm.schemas.contacts.write` | Our property group and `em_guest_key` | Yes |
| `crm.lists.read`, `crm.lists.write` | Segments, guest list import | Yes |
| `crm.objects.marketing_events.read`, `crm.objects.marketing_events.write` | Marketing events and attendance | Yes |
| `content`, `marketing-email` | Template emails, drafts, sending | Yes |
| `analytics.behavioral_events.send`, `behavioral_events.event_definitions.read_write` | Custom behavioural events | Optional (Enterprise) |

Optional scopes are only granted on portals that have them. The connection records what was granted, and features follow from that.

### What HubSpot's plans allow

| | Any Marketing Hub plan | Marketing Hub Enterprise |
|---|---|---|
| Contacts, marketing events, attendance, segments, list import | ✓ | ✓ |
| Drafts made by the platform | ✓ | ✓ |
| Send or schedule from the platform | – (the manager sends in HubSpot) | ✓ |
| Custom behavioural events | – | ✓ |

Sending a regular email through the API needs Marketing Hub Enterprise (or HubSpot's transactional email add-on). The connection page shows which column the portal is in, found by a capability check after connecting, so nobody discovers it at send time.

### Setup in the portal

Idempotent, rerun from the admin ("Repair setup"):

- Contact property group **Event manager**, with the property `em_guest_key` (single-line text, read-only in the HubSpot UI where HubSpot allows it).
- Custom event definitions, if the optional scopes were granted.

## Contacts and the guest key

### What we write

| Property | Value |
|---|---|
| `email` | Guest email, the match key |
| `firstname`, `lastname` | Split from the guest name; only written if empty in HubSpot, never overwriting the client's data |
| `hs_language` | Guest locale, same rule |
| `em_guest_key` | The guest key, below |

Nothing else. **No event, invitation or RSVP data on the contact**: a contact can be invited to several events at the same time, and single-valued properties would overwrite each other. Per-event state lives in segments, marketing event attendance and custom events. Form answers never leave the platform.

Contacts are matched on the HubSpot record id when we have one (`external_contact_id` from a HubSpot import, or our own mapping), else on email. Upserts are batched: a keyed job per contact with a short delay, collected into batch calls, which keeps us inside HubSpot's rate limits during an import of thousands of guests.

Who is synced is an account setting: invited guests (default on) and open-registration attendees (default off).

### Why a guest key

A HubSpot email can only personalise with the recipient's properties. The personal invitation link needs a secret per recipient, so that secret has to be a contact property. To work for every event at once, it is **per contact, not per invitation**, and the event goes in the link itself:

```
https://<attendee host>/h/<eventId>/{{ contact.em_guest_key }}
```

- The key is a token from `registration/tokens.ts` with a new purpose `guest_key`: HMAC under the account's token key over (account, HubSpot contact id, key version). It is written on the contact's first sync and never changes unless rotated.
- The event id is put into the link when the platform makes the draft, so each draft has its event's link and the contact token fills in the rest.
- `GET /h/<eventId>/<key>` on the attendee app checks the key, finds the HubSpot contact, then the event's invitation for that contact, and shows the same page as `/i/<token>`. Accepting, declining and the confirmation email work as today.
- Not invited to that event, a key from another account, a rotated key, or a disconnected portal: the existing "link not valid" page, with no hint of why.
- **Rotation** ("Reset guest key" on a guest, or for all guests on disconnect and reconnect) bumps the version and rewrites the property. Rotating an invitation's own link (`rotateInvitationLink`) does not affect the guest key, and the other way round.

The key opens only invitations the platform has for that contact. Someone who forwards a HubSpot email forwards the invitation, exactly as with the platform's own emails.

## Marketing events and attendance

- **One marketing event per occurrence**: `externalAccountId` = account id, `externalEventId` = occurrence id, name, start and end, organiser (account name), type (`In person`), URL to the public event page.
- Created when the event is published, updated on `event.changed`, `occurrence.changed` and `occurrence.relocated`, marked cancelled on `occurrence.cancelled` and `event.cancelled`, restored when restored.
- **Attendance** by email: `register` on `registration.confirmed`, `cancel` on `registration.cancelled` and when moved to another occurrence (with `register` on the new one), `attend` on check-in when scanning lands (#7). Waitlisted and offered registrations are not registered until confirmed.
- Marketing events work on every HubSpot plan and show on the contact's timeline, which covers "did this person come to our events" without Enterprise.

### Custom behavioural events (Enterprise)

When the optional scopes are granted we also send:

| HubSpot event | From |
|---|---|
| `em_invited` | `invitation.sent` |
| `em_declined` | `invitation.declined` |
| `em_registered` | `registration.confirmed` |
| `em_waitlisted` | `registration.waitlisted` |
| `em_cancelled` | `registration.cancelled` |
| `em_checked_in` | `checked_in` (#7) |

Each with event id and name, occurrence id and start, channel (`platform`, `hubspot`, `external`) and party size. These are for the client's own reporting and workflows.

## Segments

When an event's channel is set to HubSpot, the platform creates static segments for it in the portal, named `EM · <event name> · …`:

| Segment | Members | Used by |
|---|---|---|
| **Invitation recipients** | The guests picked in "Send invitations" (not yet sent, or named for a resend). Rebuilt for each send | Invitation email |
| **Awaiting reply** | Sent an invitation, not accepted or declined | Invitation reminder |
| **Confirmed · <occurrence>** | Confirmed registrations of that occurrence | Reminder before the event |

### Kept in step under the hood

An outbox handler updates memberships on every change that affects them: `invitation.sent`, `invitation.declined`, `registration.confirmed`, `registration.cancelled`, `registration.changed` (moved to another occurrence), `registration.waitlisted` and `registration.offered`. Changes are collected per segment in a keyed job with a few seconds' delay and applied as batch add and remove calls, so a busy RSVP hour costs a handful of calls, not one per guest.

### Reconciled before every send

Incremental updates can lag or fail. So every send first **reconciles**: it reads the segment, compares it with the platform's own list and adds and removes the difference, then sends. The audience of a send is always what the platform says at that moment. A nightly reconcile also catches drift, such as someone adding contacts to the segment by hand in HubSpot; the sync log reports what it fixed.

A guest whose contact could not be synced (an invalid email by HubSpot's rules, a sync error) is flagged in the guest list and listed before a send, never silently left out.

The segments are ours: renaming them in HubSpot is fine, editing their members is undone by the next reconcile, and deleting one makes the platform create it again. They are archived when the event is archived.

## HubSpot emails

### Choosing the channel

Event setting **Invitations and reminders sent from**: *the platform* (default) or *HubSpot*, offered when the account is connected. It covers the invitation, the invitation reminder and the reminder before the event. Everything else stays in the platform: registration confirmation with the QR code, changes, cancellations, moved and cancelled occurrences, and waitlist emails.

The channel can change until the first invitation is sent; after that it is locked, so one event never mixes two senders for the same email.

### Template emails

The account chooses a **default HubSpot email per kind** (invitation, invitation reminder, reminder before the event) in Settings → Integrations, picked from the portal's marketing emails. An event can choose others.

A template is an ordinary HubSpot email the client designs, with two placeholders as literal text, typically as button URLs:

| Placeholder | Becomes |
|---|---|
| `[[em:invitation_link]]` | `https://<attendee host>/h/<eventId>/{{ contact.em_guest_key }}` |
| `[[em:event_link]]` | The public event page |

Event details (title, date, place) are written into the email by hand in HubSpot, or the template uses its own text; we do not generate body copy. The platform warns when a template has no `[[em:invitation_link]]`.

### Making a draft

From the event's guest list, **Create HubSpot draft** for a kind. The platform opens a small form, prefilled from the event, and then:

1. **Clones** the template email.
2. Sets the **email name** (`EM · <event> · Invitation`, `· Invitation reminder`, `· Reminder <occurrence date>`), **subject** and **preview text** from the form.
3. Sets the **recipients** to the matching segment.
4. Replaces the **placeholders** with the event's links.
5. Associates it with the account's HubSpot **campaign**, if one is set on the event.

The draft is stored on the event, and the guest list links straight to it in HubSpot for design changes. Subject and preview text can be changed again from the platform until the email is sent; anything else is edited in HubSpot. One draft per kind (and per occurrence for the reminder before the event); making it again replaces an unsent draft.

### Sending (Enterprise)

**Send now** or **Schedule** from the guest list:

1. For an invitation, the recipients segment is rebuilt from the guests picked, with the same rules as the platform's own sending (not sent yet, or named for a resend; skip those who answered).
2. The segment is reconciled.
3. The email is published, which sends it or schedules it in HubSpot.
4. One send per recipient is logged through the same path as `markSentExternally`, with `channel: "hubspot"`, which emits `invitation.sent.v1` and moves the guests into *Awaiting reply*.

A scheduled email is reconciled again just before its send time. Cancelling a scheduled send in the platform unschedules it in HubSpot.

### Reminder before the event

The platform still schedules it from the event's `reminderMinBefore`, as today. On the HubSpot channel the job at reminder time reconciles *Confirmed · <occurrence>* and sends that occurrence's prepared reminder draft. A week before (or at once, if sooner) the guest list warns about occurrences with no draft; without one, nothing is sent and the sync log says so. The HubSpot email links to the manage page, which shows the QR code.

### Without Enterprise

The platform makes the drafts and keeps the segments; the manager sends or schedules in HubSpot. The platform checks the email's state every few minutes after a draft is made and, once HubSpot reports it sent, logs the sends as above. Until then the guests stay "not sent" in the guest list. The reminder before the event cannot be timed by the platform here; the manager schedules it in HubSpot and the segment is kept current until it goes.

### Delivery

The guest list shows "Sent via HubSpot". Bounces, unsubscribes and opens stay in HubSpot. HubSpot only delivers marketing email to marketing contacts with the right subscription, so a guest who has unsubscribed from the client's marketing gets nothing; the setup guide explains this, and the send summary lists recipients HubSpot excluded where the API reports them.

## Guest list from a HubSpot list

The guest import (`GuestImport.tsx`) gains a source: **From HubSpot**.

1. Pick a list or segment from the portal (searched by name).
2. The platform fetches its members (email, name, the locale property chosen in the column mapping, record id) into the existing staging (`registration.guest_import`).
3. Preview and commit as for a file: row errors, duplicates, re-import matched on email, removals listed and never silent.
4. `external_contact_id` is set to the HubSpot record id, so later syncs match on it.

The list is remembered on the event; **Refresh from HubSpot** re-runs the import with the same rules. There is no live sync.

## Data model

New module `integrations` (ADR 0001), schema `integrations`:

- `connection`: `tenant_id`, `provider` (`hubspot`), `status` (`active`, `needs_reconnect`, `disconnected`), `external_account_id` (portal id), `scopes[]`, `features` (`send_api`, `custom_events`), `settings` (who to sync, default templates), `connected_by`, `connected_at`. One active HubSpot connection per account.
- `credential`: refresh and access token, expiry, encrypted with the account's data key.
- `sync_item`: `kind` (`contact`, `marketing_event`, `segment`, `email`), `local_id`, `remote_id`, `last_synced_at`, `last_error`.
- `delivery`: `outbox_event_id`, `handler`, `status`, `attempts`, `last_error`, `next_attempt_at`. The sync log, dead letter and replay. Shaped so outgoing webhooks (#94) can use it too.

Changes elsewhere:

- Envelope encryption moves from `registration/secrets.ts` to `shared`, with the stored format unchanged, so both modules use it.
- `catalog.event`: `invitation_channel` (`platform` | `hubspot`), HubSpot template overrides and campaign id (as settings, read only by the connector).
- `registration`: `guest_key` token purpose; `invitation_send` gains `channel`; the `/h/<eventId>/<key>` lookup by HubSpot contact.

## Worker

- `apps/worker/src/integrations/hubspot/` with a `HubSpotClient` interface (real one and a fake, like `Mailer` and `FakeMailer`). The real client refreshes tokens, backs off on `429` and honours HubSpot's rate limit headers.
- One `InternalHandler` in `handlers.ts` subscribed to `invitation.*`, `registration.*`, `event.*`, `occurrence.*` (and `admission.*` when #93 lands). It only enqueues keyed jobs; the jobs call HubSpot.
- Idempotent on outbox event id (ADR 0008): replaying an event never registers twice or adds a send twice.
- Retries with backoff, dead letter after the limit, replay from the sync log.
- **Backfill** after connecting and on **Resync**: published events with upcoming occurrences, their marketing events, attendance, guests and segments.

## Admin

- **Settings → Integrations**: connect and disconnect, portal and plan features, who to sync, default template emails, "Repair setup", "Resync", and the sync log with retry and replay.
- **Event**: the channel setting and, on HubSpot, template overrides and campaign.
- **Guest list**: "Create HubSpot draft", the draft's state and link, "Send now" or "Schedule" (Enterprise), warnings for guests not synced and occurrences with no reminder draft, "Sent via HubSpot" in the send column.
- **Guest import**: the "From HubSpot" source and "Refresh from HubSpot".

## Data protection

- Syncing is opt-in per account, with separate switches for invited guests and open-registration attendees. The client is the controller for what lands in their portal; we write only name, email, locale, the guest key and event attendance.
- The platform's anonymisation does not reach into HubSpot. The setup guide says so, and that the client's own retention applies there.
- Disconnecting deletes our tokens and mappings and invalidates guest keys.

## Milestones

0. **Spike** on a HubSpot developer test portal: current API version and scope names; clone and draft update, including the recipient field and replacing link text in content; publish and schedule through the API on Enterprise; `{{ contact.em_guest_key }}` inside a link URL; segment membership limits; marketing event attendance by email. Results go back into this document.
1. **Connection**: integrations module, shared encryption, OAuth, setup job, Settings → Integrations.
2. **Contacts and marketing events**: contact sync with the guest key, `/h/<eventId>/<key>`, marketing events and attendance, backfill, sync log.
3. **Segments**: incremental updates and reconcile.
4. **HubSpot emails**: channel setting, templates, drafts, send and schedule, reminder before the event; client setup guide.
5. **Guest list from HubSpot**.
6. **Custom behavioural events** (Enterprise).

Depends on #93 (`admission.issued`, `reminder.due`) and #7 (`attend`). #94 reuses the `delivery` log.

## Testing

- **Worker** (`apps/worker/test/hubspot.test.ts`, fake client): each outbox event gives the expected calls; replayed events change nothing; segment changes are coalesced; reconcile fixes a drifted segment before a send; a send logs one `invitation_send` per recipient and emits `invitation.sent.v1`; a refused token pauses sync; `429` backs off.
- **Domain** (`packages/domain/test/acceptance/integrations.test.ts`): connection and encrypted credentials; guest key issue, verify and rotate; a contact invited to two events at once reaches both through `/h/…`.
- **Attendee** (`apps/attendee/test/hubspot-link.test.ts`): valid key; key for an event the contact is not invited to; rotated key; key from another account; disconnected portal.
- **API** (`apps/api/test/integrations.test.ts`): OAuth `state` checks and callback; draft, send and schedule endpoints; owner-only connect.
- **Contract tests** against recorded HubSpot responses for every endpoint we call.
- **End to end** on a HubSpot test portal in staging: connect, import a list, make an invitation draft from a template, send, accept through the link in the HubSpot email, see *Awaiting reply* and *Confirmed* change and attendance on the marketing event, schedule the reminder, cancel, disconnect.

## Open questions

1. **Placeholders**: can the clone's content be edited reliably through the API for every kind of template (drag-and-drop and coded), or do we need a custom module in our app that renders the link? To settle in the spike.
2. **Guest key and existing contacts**: when a guest's email matches a HubSpot contact that already has an `em_guest_key` from another account of ours in the same portal (two accounts, one portal), do we refuse the second connection or namespace the property per account?
3. **Open registration on HubSpot**: should open events (no invitations) also get a *Confirmed* segment and the reminder before the event from HubSpot, or is the HubSpot channel for invite-only events only?
4. **Locale**: write `hs_language` from the guest's locale, or leave language entirely to HubSpot?
