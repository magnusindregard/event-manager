# HubSpot connector

*Draft, 20 November 2026; milestone 1 (connection) built 21 November; spike run 22–23 November. Issue #95, part of epic #9. Builds on [docs/registration.md](registration.md). Decisions: [ADR 0017](adr/0017-hubspot-connector.md), [ADR 0008](adr/0008-events-and-webhooks.md).*

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

1. Settings → Integrations → **Connect HubSpot** (owner only). `POST /v1/integrations/hubspot/authorize` returns HubSpot's install URL with a signed `state` (account, user, ten-minute expiry; HMAC with a key derived from the app's client secret, so no table), and the admin sends the browser there.
2. The portal admin picks the portal and approves the scopes.
3. HubSpot sends the browser back to the **admin's** callback page, `<admin>/integrations/hubspot/callback`, which posts `code` and `state` to `POST /v1/integrations/hubspot/callback` with the signed-in owner's own token. The API refuses a `state` for another account or started by another user, so a link someone else started cannot connect their portal to your account, or yours to theirs. It then exchanges the code, reads the portal id and granted scopes, and stores the refresh and access token encrypted. An install missing a required scope is refused and revoked again.
4. A setup job creates what we need in the portal (below); the backfill comes with milestone 2.

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
| `communication_preferences.read_write`, `communication_preferences.statuses.batch.read`, `communication_preferences.statuses.batch.write` | Subscription types: the event type picker, and keeping temporary marketing contacts out of other marketing (see "Cleanup after HubSpot sending") | Optional; a portal admin must allow them for the app first |
| `automation` | The workflow that sets contacts back to non-marketing | Optional; a portal admin must allow it for the app first |

Optional scopes are only granted on portals that have them. The connection records what was granted, and features follow from that. The list lives in `packages/hubspot/src/index.ts` and must match the app definition in `integrations/hubspot-app/` (a test checks).

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

- Contact property group **Event manager** (`event_manager`), with the property `em_guest_key` (single-line text, not a form field). Whether it can be made read-only in the HubSpot UI is for the spike.
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

- `connection`: `tenant_id`, `provider` (`hubspot`), `status` (`active`, `needs_reconnect`, `disconnected`) and `status_reason`, `external_account_id` (portal id), `scopes[]`, `settings` (who to sync; default templates later), `setup_status`/`setup_error`/`setup_at`, `connected_by`, `connected_at`, `disconnected_at`, and `generation`, bumped on every connect and disconnect: the worker writes tokens, setup results and `needs_reconnect` back only to the generation it loaded, so a job that outlives a reconnect to another portal cannot touch it. One row per account and provider, kept on disconnect. Features (`customEvents`, later `sendApi`) are derived from the scopes and capability checks, not stored. Reconnecting the same portal reuses the row; another portal needs a disconnect first.
- `credential`: refresh and access token as one ciphertext under the account's data key, bound to the connection id, plus the access token's expiry.
- `sync_item` (milestone 2): `kind` (`contact`, `marketing_event`, `segment`, `email`), `local_id`, `remote_id`, `last_synced_at`, `last_error`.
- `delivery` (milestone 2): `outbox_event_id`, `handler`, `status`, `attempts`, `last_error`, `next_attempt_at`. The sync log, dead letter and replay. Shaped so outgoing webhooks (#94) can use it too.

Changes elsewhere:

- Envelope encryption moves from `registration/secrets.ts` to `shared/secrets.ts` (`encryptJson`/`decryptJson` with a context string), and `registration.data_key` to `platform.data_key`, with the stored format unchanged, so both modules use it.
- `catalog.event`: `invitation_channel` (`platform` | `hubspot`), HubSpot template overrides and campaign id (as settings, read only by the connector).
- `registration`: `guest_key` token purpose; `invitation_send` gains `channel`; the `/h/<eventId>/<key>` lookup by HubSpot contact.

## Worker

- `packages/hubspot`: the `HubSpotClient` interface, the real `HttpHubSpot` and `FakeHubSpot` (like `Mailer` and `FakeMailer`), shared by the API (OAuth) and the worker. The worker's `withHubSpot` (`apps/worker/src/hubspot/session.ts`) refreshes a token about to expire, and once more if HubSpot refuses one anyway; only a refused refresh sets `needs_reconnect`. `429` and `5xx` fail the job so graphile-worker retries with backoff; honouring rate limit headers within a job comes with the batch calls in milestone 2.
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

## Running the spike

`apps/worker/src/hubspot/spike.ts` runs milestone 0's checks against a portal and records what HubSpot answers. Each step is a question from the milestone; a refused step is a finding, and the run goes on. It refuses to start unless the token belongs to the portal named with `--portal`, so it cannot write to a real portal by mistake.

1. A HubSpot developer account with the app uploaded (`integrations/hubspot-app/README.md`) and a **developer test account** (portal), on Marketing Hub Enterprise to try sending and custom events.
2. In the test portal, design a marketing email to use as the template, with a button whose URL is `[[em:invitation_link]]`. Try both a drag-and-drop and a coded template.
3. Connect the test portal from the admin (a local stack with the app's client id and secret works), so the token is ours and the setup job has run.
4. Run it, with an inbox you can read:

```bash
pnpm --filter @event-manager/worker hubspot-spike --portal <test portal id> --email <your inbox> --account <account id> --template-email <email id>
```

`--account` reads the connection's tokens from the database (`DATABASE_URL`, `SENSITIVE_DATA_KEYS`, `HUBSPOT_CLIENT_ID`/`SECRET`) and refreshes them like the worker; `HUBSPOT_ACCESS_TOKEN=…` works instead. Without `--template-email` it lists the portal's emails. Add `--send` to publish the draft, which **sends a real email** to the test contact; open it and check that the link reaches `/h/spike-event/<the contact's key>`. `--single-send-email <id>` names an email saved for the single-send API with `[[em:invitation_link]]` in it; the spike clones it, publishes the clone and, with `--send`, sends to `--email` and two plus addresses of it, which makes them all marketing contacts (`--single-send-direct` sends from the named email instead of a clone). `--keep` leaves what it created (contact, segment, marketing event, draft, event definition); otherwise it cleans up.

It writes `summary.md` (a table of question, outcome and HubSpot's answer, ready to paste below) and one recording per step to `spike-output/` (git-ignored), with tokens and the test address redacted. The recordings are the start of the contract-test fixtures.

### Results

**Run 1, 22 November 2026**, developer test account 148058020 (`accountType` SANDBOX), app 63032708, drag-and-drop template, with `--send`.

| Question | Finding | What it means for the design |
|---|---|---|
| App definition and scope names | `hs project upload` accepted `integrations/hubspot-app/`. The install granted all 10 required and both optional scopes. Connecting through the admin, the setup job and the property group all worked against real HubSpot | Milestone 1 holds as built |
| Is the plan visible? | `/account-info/v3/details` gives type, time zone, currency and data hosting, but **not the Marketing Hub tier** | Detect "can send through the API" by trying, as planned, not by reading the tier |
| Read-only `em_guest_key` | `PATCH modificationMetadata.readOnlyValue=true` answers 200, but the value **stays `false`** | It cannot be made read-only. The setup guide must say not to edit it; rotation repairs a damaged key |
| Contact upsert by email with the key | Works (`batch/upsert`, `idProperty: email`) | As designed |
| Static segment | Create, add, remove and read members all work (`/crm/v3/lists`, `processingType: MANUAL`). Batch limits not measured yet | As designed |
| Marketing event and attendance by email | Create, `register` and `attend` by email all answer 200. The breakdown read straight after shows `total: 0` | Attendance is probably processed asynchronously; re-read later in run 2 before relying on it |
| Clone and placeholder | Clone works, keeps `emailTemplateMode: DRAG_AND_DROP`, and `[[em:invitation_link]]` is in the content as literal text | Placeholders work for drag-and-drop templates; coded templates still to try |
| Draft: name, subject, link | All set by PATCH. The placeholder replaced with `…/h/<event>/{{ contact.em_guest_key }}` reads back as written | As designed; whether the token renders in a sent email is for run 2 |
| Draft: preview text | Not a field on the email: it is a module, `content.widgets.preview_text.body.value` | Set it in the content, like the link |
| Draft: recipients | After we set our segment, the email also listed `contactLists: [781]`. *Corrected in run 3:* that is our own segment under its **legacy list id**, which HubSpot adds by itself; the clone had no recipients | Set every recipient kind (`contactIlsLists`, `contactLists`, `contactIds`) and check the result before sending, resolving `contactLists` ids with `GET /crm/v3/lists/idmapping?legacyListId=`. The spike does this and will not publish otherwise |
| Publish through the API | Refused with `400 VALIDATION_FAILED`: `CAN_SPAM_NOT_CONFIGURED` (the portal has no email footer address) and `NOT_SET: SUBSCRIPTION` (the email has no subscription type). Not a plan refusal | The platform must check a draft is publishable and show HubSpot's reasons. The setup guide covers the footer and the template's subscription type. Retry in run 2 |
| Custom behavioural events | Defining and sending both work (`pe148058020_em_spike_…`) | As designed |
| Cleanup | Everything the spike made was deleted | – |

Run 1 used email 521529124032, an ordinary marketing email rather than a template, which is why its recipient list came along.

**Run 2, 22 November 2026**, same portal, after adding the email footer; template 521529113795 (a saved HubSpot email template), subscription type "Informasjon fra Munchmuseet".

| Question | Finding | What it means for the design |
|---|---|---|
| Can a saved HubSpot email template be the template? | **No.** `POST /marketing/v3/emails/clone` answers `404 OBJECT_NOT_FOUND: The model 521529113795 does not exist`: the clone endpoint only takes marketing emails | A template is a **draft marketing email** the client keeps for the purpose (e.g. "EM · Invitation template"), as the design already says. The template picker lists marketing emails, and the setup guide says to save the design as a draft email, not as a HubSpot template |
| Subscription type on a template | HubSpot has no subscription type on templates; it is set per email | The platform sets `subscriptionDetails.subscriptionId` on every draft it makes. The account chooses a default subscription type, and an event can override it |
| Can we list subscription types? | `GET /communication-preferences/v3/definitions` answers `403 MISSING_SCOPES` | Needs another scope (expected `communication_preferences.read`) so the admin can offer the types. Without it, the platform could only take an id typed in |
| Attendance after a delay | The breakdown still shows `total: 0` straight after `register` and `attend` | Still to read again some minutes later |

**Runs 3 and 4, 22 November 2026**, same portal, template **521501446340** (a draft marketing email with the subscription type set), with `--send`.

| Question | Finding | What it means for the design |
|---|---|---|
| Does a clone keep the template's subscription type? | **Yes** (`subscriptionDetails.subscriptionId` 2343918412 came along) | A client can set the subscription type on their template draft; the platform only needs to set it when the account or event chooses another. The extra scope is then a nice-to-have for the admin's picker, not a blocker |
| Recipients after setting our segment | `contactIlsLists: [1527]` and `contactLists: [783]`, which is 1527's legacy id. The clone itself had no recipients | See the corrected row in run 1. The guard stopped run 3 from sending until it resolved legacy ids |
| Preview text through the content module | Set and read back | As planned after run 1 |
| **Publish through the API** | **Works**: `POST /marketing/v3/emails/{id}/publish` answers `204` and the email goes to `PRE_PROCESSING` (run 4) | The "send from the platform" path works on this portal. Whether a non-Enterprise portal refuses it, and with what error, still needs a portal on a lower plan |
| Deleting a segment a sent email uses | `400`: the list is "blocked for list modification/deletion due to these references" (the email) | Segments of sent emails cannot be deleted. Archiving an event leaves them (renamed or simply left), not deleted |
| Delivery | Run 4 deleted the test contact seconds after publishing (a spike bug, now fixed); two minutes later the email was still `PRE_PROCESSING` with no counters | Rerun to see the email arrive and check the rendered link |
| Attendance | Still `total: 0` straight after `register` and `attend` | Still to read again later |

**Run 5, 22 November 2026**: the same as run 4, with cleanup keeping the contact and the segment for delivery.

| Question | Finding | What it means for the design |
|---|---|---|
| Is the email delivered? | Published (`204`), then `PRE_PROCESSING` → `PROCESSING` → `PUBLISHED` within 8 minutes. Counters: `selected 1, suppressed 1, notsent 1`. **Nothing was sent** | – |
| Why suppressed? | The contact we created has **`hs_marketable_status: false`**: contacts created through the API are non-marketing contacts, and HubSpot sends marketing email only to marketing contacts. The property is **read-only through the API**. `hs_legal_basis` is empty too (the portal is EU-hosted, so GDPR settings may also apply) | **A HubSpot invitation reaches only guests who are already marketing contacts.** The platform cannot make a contact one. So: (1) before a send, read `hs_marketable_status` for the recipients and show how many HubSpot will suppress; (2) the setup guide tells the client how to make the contacts we create marketing contacts (portal setting for contacts from integrations, or a workflow), and about legal basis under GDPR; (3) guests imported from a HubSpot list are usually marketing contacts already, which fits the main use case. This needs deciding before milestone 4 |

**Run 6, 23 November 2026**: the same, after the test contact was made a marketing contact by hand in HubSpot.

| Question | Finding | What it means for the design |
|---|---|---|
| Is the email delivered to a marketing contact? | **Yes**: `sent 1, delivered 1, suppressed 0`, about 12 minutes after publishing (`PRE_PROCESSING` → `PUBLISHED`) | The whole path works: clone, draft, our segment as the only recipients, publish through the API, delivery. The only blocker is marketing contact status |
| Does the personal link render? | **Yes**: the button in the received email links to `http://localhost:3020/h/spike-event/spike-202611230806-26b1`, the contact's key at send time | `{{ contact.em_guest_key }}` inside a link URL is filled in per recipient, unencoded. The guest key design holds |

**Runs 7–14, 24 November 2026**: the **marketing single-send API**, a third way of sending besides regular and automated emails. The platform sends one email per guest, with per-send values as `{{ custom.<name> }}`; HubSpot warns that everyone sent to becomes a marketing contact. Email 521501446340 was saved for single-send in HubSpot. The spike sent from a clone of it (and in run 11–12 from the email itself) to three addresses: two plus addresses of the test inbox, one an existing non-marketing contact and one with no contact, and from run 12 the test address itself.

| Question | Finding | What it means for the design |
|---|---|---|
| How does the API show a single-send email? | `type: MARKETING_SINGLE_SEND_API`, `subcategory: marketing_single_send_api`; state `AUTOMATED_DRAFT` until published, then `AUTOMATED`. The other 98 emails in the portal are `AUTOMATED_EMAIL/automated` | The template picker filters on this type |
| Does a clone stay single-send? | **Yes**, type and subcategory kept, and the content can be patched as for regular emails. A clone starts as a draft even when the template is published | The platform can make one email per event from the client's template, or use one template for all events and pass the event in custom properties |
| Can a draft be sent? | **No**, despite the guide: `400 "Email is in a draft state"` (`sendResult: MISSING_CONTENT`). Publishing it (`POST …/publish`, `204`) sends nothing; sends are accepted some seconds later, not straight away | Publish the single-send email when it is made, and retry the first send briefly |
| Endpoint | `POST /marketing/email-campaigns/2026-09/single-send`; the v4 path was not needed. Rate limit headers: daily 1,000,000 | – |
| Is a send delivered? | **Yes, to the plain address** (`sendResult: SENT`, delivered), from the clone and from the email itself. **Every send to a plus address** (`name+tag@…`) completes as `VALIDATION_FAILED`, also from a contact created minutes before like the plain one, and with no further reason in the API | Guests with a `+` in their address cannot be reached this way and need the platform's own email as fallback. `VALIDATION_FAILED` is a per-guest result to handle, not a failure of the send |
| Personal link | The clone's button is `<attendee host>/i/{{ custom.invitation_token }}`, with the token passed per send | **Works**: the button in the received email (run 14) opens `…/i/spike-plain-202611241814-1c59`, the token of that send. The link needs no guest key and no secret stored in HubSpot |
| Repeated `sendId` | Two sends with the same `sendId` gave one `SENT` and one `IDEMPOTENT_IGNORE`, so one email; HubSpot processed the repeat first, so the *first* request reported `IDEMPOTENT_IGNORE` | Safe to retry with the invitation send's id as `sendId`; treat `IDEMPOTENT_IGNORE` as "already sent", never as a failure |
| Marketing contact status | **Every recipient became a marketing contact, also when the send failed validation.** A new address got a contact with reason `EMAIL` / `MarketingSingleSendEmailApi`. Often the reason read `WORKFLOW` 3969697002: the portal has a workflow that also sets marketing status | Under this option every invited guest is a billable marketing contact, even one HubSpot does not deliver to, which is exactly the museum concern |

What single-send would change: no guest key (the platform's own invitation token goes in a custom property and is never stored in HubSpot), no segments or reconcile for sending, the platform times every send itself including the reminder before the event, a result per guest, and the platform's own email as fallback for guests HubSpot refuses (plus addresses, unsubscribed and so on). Still Enterprise only.

Left in the sandbox by these runs, to see the sends there: the published clones and their test contacts, all named `EM spike · <tag>`.

### What the spike leaves to decide

HubSpot sending works, but **only for marketing contacts, which an app cannot create** (runs 5–6). In the museum case many invitees (lenders, the artist's family, other museums) should not be in HubSpot at all, let alone as billable marketing contacts. The options on the table, not yet decided:

1. **Keep HubSpot sending, with a client workflow** that makes our contacts marketing contacts and cleans them up after X days, explained by dialogues in the admin. Caveats: marketing contacts are likely billed at the period's peak even if removed, it creates CRM records for people outside the client's marketing (GDPR), and it relies on workflows the platform cannot see.
2. **Split per recipient**: HubSpot sends to marketing contacts, the platform to the rest. Every guest is reached, but invitations come from two senders in two designs.
3. **Drop HubSpot sending, keep the rest**: the platform sends all invitations with account-branded templates (as planned for #100); HubSpot keeps marketing events, attendance, segments and custom events. One sender, consistent branding, no marketing contact problem; clients lose HubSpot's designer and email reporting for invitations.
4. **Drop the integration** and build email templating in the platform.
5. **Single-send API** (runs 7–14): the platform sends each guest's invitation and reminders through HubSpot, one call per guest, with the guest's own link as a custom property. HubSpot makes every recipient a marketing contact by itself, so no client workflow is needed to send. It replaces drafts, segments-for-sending, the guest key and polling, and gives a result per guest with the platform's own email as fallback. It is Enterprise only, and every guest becomes a billable marketing contact for at least one billing period, which makes the cleanup below a requirement.

Options 1 and 5 both turn guests into marketing contacts, so both need the cleanup below.

ADR 0017 and the "HubSpot emails" section above follow option 1 as written and need revising once this is decided. Milestones 2 and 3 (contacts, marketing events, segments) hold under options 1–3.

Still open: attendance read later; a coded template; publishing on a non-Enterprise portal.

### Cleanup after HubSpot sending (draft, 24 November 2026)

When HubSpot sends invitations, the platform puts people into the client's portal as marketing contacts who would not otherwise be there. The platform takes that back afterwards, and keeps those people from getting the client's other marketing in the meantime:

- **Contacts the platform created are deleted.**
- **Contacts the platform turned into marketing contacts are set back to non-marketing.**
- **While they are marketing contacts because of us, they get no other marketing email** from the portal: no newsletters, no automated emails, nothing but the event's own emails.

Contacts that were marketing contacts before the platform touched them are the client's: the platform changes nothing about them, neither during nor after.

#### What HubSpot allows

| Need | HubSpot | Source |
|---|---|---|
| Delete a contact | `DELETE /crm/v3/objects/contacts/{id}` (restorable for 90 days in HubSpot), or the GDPR delete for a permanent one | Runs 1–14 |
| Set a contact to non-marketing | **Not through the API**: `hs_marketable_status` is read-only (run 5). Only in the UI (Marketing contacts → Clean up contacts, or the contacts index) or with the workflow action *Set marketing contact status* | HubSpot knowledge base |
| When non-marketing takes effect | At the portal's next **update date**: the renewal day each month for monthly plans, the first of each month for yearly ones. Until then the contact counts as marketing (`hs_marketable_until_renewal` is true) | HubSpot knowledge base |
| What it costs | The marketing contact tier goes up automatically when exceeded and never down before renewal. Deleting a marketing contact frees capacity, but HubSpot does not say whether at once or at the update date | HubSpot knowledge base |
| Keep a contact from other marketing | Every marketing email has a **subscription type**, and HubSpot does not send it to a contact unsubscribed from that type. The v4 subscriptions API sets a contact's status per type (`SUBSCRIBED`, `UNSUBSCRIBED`, `NOT_SPECIFIED`); in portals with data privacy settings on, every write needs `legalBasis` and `legalBasisExplanation` | v4 subscriptions guide |
| Unsubscribe from everything | `…/statuses/batch/unsubscribe-all` exists, but would block the event's own emails too; there is no "all but one" | v4 subscriptions guide |

So deleting is in our hands; setting back to non-marketing needs a workflow in the portal; keeping people from other marketing is done through subscription types.

#### Remembering what the platform did

The cleanup can only undo what the platform knows it did, so it records it **before the first HubSpot send to a contact**. Per contact (in `integrations.sync_item`, kind `contact`, or a table of its own):

| Field | Meaning |
|---|---|
| `created_by_us` | No contact had the email when the platform first synced it (the upsert's `new` flag, or a search before a single-send) |
| `marketable_before` | `hs_marketable_status` before the first send |
| `subscriptions_before` | The contact's status per subscription type before the platform changed any |
| `subscriptions_set` | The types the platform unsubscribed |
| `marketing_by_us_at` | When a send of ours made the contact a marketing contact |
| `needed_until` | When the platform last needs to email this contact through HubSpot (below) |
| `cleanup_status` | `none`, `pending`, `deleted`, `restored`, `kept` (with reason), `failed` |

A contact that was already a marketing contact gets `marketable_before: true` and nothing more: the platform does not touch its subscriptions and never cleans it up.

#### While a guest is a marketing contact because of us

1. **A subscription type of its own for event emails.** The account picks one in Settings → Integrations, for example "Invitasjoner og arrangementer". The platform's HubSpot emails use only that type, and the setup guide says no other email may use it. The platform warns if the type is also used by emails it did not make (it can list the portal's emails and their `subscriptionDetails`).
2. **Unsubscribe from every other type** before the first send, for contacts with `created_by_us` or `marketable_before: false`: the platform reads the portal's subscription types and sets every one except the event type to `UNSUBSCRIBED`, recording what it changed. Every marketing email, including the client's automated emails and newsletters, carries a type, so this keeps the guest out of all of them.
3. **New subscription types** created in the portal later are not covered by step 2. The nightly reconcile reads the types again and unsubscribes our temporary contacts from new ones.
4. **A static segment `EM · Temporary marketing contacts`** holds all of them, for the client to exclude from lists and workflows as well. This is belt and braces; the subscription types are what actually stops the emails.

Legal basis: in a portal with data privacy settings on, each unsubscribe is written with a legal basis and the explanation "Event manager: temporary contact for an event invitation; not for other marketing". Which legal basis HubSpot accepts for an unsubscribe is for the spike.

#### When a contact is no longer needed

`needed_until` is the latest of, over all the contact's invitations and registrations sent through HubSpot in the account: the end of the occurrence plus a grace period (default 7 days, an account setting), so the reminder and any after-event email go out first. It moves when the guest is invited to another event, registers for another occurrence, or an event is moved. A guest who declines and has nothing else open is needed until the invitation's last reminder would have gone, which in practice is soon.

A nightly job picks up contacts whose `needed_until` has passed.

#### Cleaning up a contact

**Created by us:**

1. Check that the client has not taken the contact into use since: no associations (companies, deals, tickets), no owner, no form submissions, no list memberships other than our own segments, and no marketing event attendance other than our events. If any of these holds, the contact is the client's now: treat it as "turned into marketing by us" below and mark it `kept (in use)` in the sync log.
2. Otherwise delete it, and drop the platform's mapping. The platform's own registration data is unaffected.

**Turned into marketing by us** (`marketable_before: false`):

1. Put the subscriptions back to `subscriptions_before`, only for the types the platform changed, and only where the contact has not changed them since (it is the guest's own choice then).
2. Add the contact to the static segment `EM · Set to non-marketing`. A workflow in the portal, enrolled on that segment, runs *Set marketing contact status → non-marketing* and removes the contact from the segment. The status changes at the next update date.
3. Remove the contact from `EM · Temporary marketing contacts`.

The workflow lives in the portal, but the platform creates it during setup through the automation API (scope `automation`; run 16 showed it can) and checks it on "Repair setup". The connection page checks that the segment empties itself; contacts left in it for more than a day show as a warning.

**Already marketing before** (`marketable_before: true`): nothing.

#### Billing, honestly

A marketing contact counts for the billing period it was marketing in, and setting it back only takes effect at the next update date. So each guest invited through HubSpot costs the client a marketing contact for at least the rest of that period, and the portal's tier can go up for the year if a big invitation pushes it over. The admin says so when the HubSpot channel is chosen, with the number of guests who are not marketing contacts yet, before anything is sent. Cleaning up promptly keeps the count from growing period after period; it does not undo the current one.

#### Disconnecting

Disconnect offers **Clean up and disconnect**: it runs the cleanup at once for every pending contact (deleting, restoring subscriptions, queuing the non-marketing workflow), waits for it to finish, then disconnects. A plain disconnect leaves the contacts as they are, and the admin says how many.

#### What the spike found (runs 15–16, 24 November 2026)

After adding the four scopes to the app (`hs project upload`, build #2) and reconnecting the sandbox.

| Question | Finding | What it means for the design |
|---|---|---|
| Granting the new scopes | HubSpot accepted the scope names. On the install screen the optional scopes were **locked "by an admin"** until a portal admin allowed them in the app's admin settings. The subscription scope reads "It won't subscribe contacts who have unsubscribed" | The setup guide and connection page tell the admin to allow them first; the connection page shows which cleanup features a missing scope turns off. An app cannot re-subscribe anyone, which the design never needs |
| Does the upsert say a contact is new? | **Yes**: `batch/upsert` results carry `new: true` | `created_by_us` comes from the upsert, with no search first |
| Subscription types | `GET /communication-preferences/v4/definitions` lists the portal's nine types (one inactive). The single-send email uses "Informasjon fra Munchmuseet" | The type picker works with `communication_preferences.read_write` |
| Unsubscribe from one type and set it back | **Works**: `UNSUBSCRIBED` then `NOT_SPECIFIED` through `POST /communication-preferences/v4/statuses/{email}`, read back each time; the batch write answers `200` too. **No legal basis was needed** in this EU-hosted portal (its data privacy settings may be off) | The cleanup can put a status back exactly where it was, as long as it was `NOT_SPECIFIED`. The platform still sends a legal basis when a portal asks for one |
| Does it keep other marketing out? | **Yes**: with the test address unsubscribed from another type, an email of that type gave `PREVIOUSLY_UNSUBSCRIBED_MESSAGE` and nothing arrived, while the event type's email was `SENT`. The address was put back to `NOT_SPECIFIED` afterwards | The per-type unsubscribe is the mechanism, as designed |
| Unsubscribe-all and single-send | Inconclusive: the send went to a plus address, which fails validation anyway (`VALIDATION_FAILED`) | Not needed: per-type unsubscribes do the job |
| Set non-marketing through the API | **No**: `PATCH hs_marketable_status=false` on a marketing contact answers `200` and the value **stays `true`** | Confirms the workflow is needed |
| Create the non-marketing workflow | **Works**: the action is `actionTypeId 0-31` with `marketableType: MARKETABLE` or `NON_MARKETABLE`. The platform created a disabled contact workflow with `NON_MARKETABLE`, enrolled on a segment (`filterType: IN_LIST`, `operator: IN_LIST`), and deleted it again | The setup job creates and enables `EM · Set to non-marketing` itself and checks it on "Repair setup"; no manual step for the client |
| Why our recipients became marketing | The portal's own workflow "knowit -> Marketing contact" (3969697002) sets contacts to marketing, which is why the reason often read `WORKFLOW` | A portal can make our contacts marketing by itself. The cleanup still treats them by `created_by_us` and `marketable_before`, whoever flipped them |

Still to try: enabling the created workflow and seeing a contact in the segment set to non-marketing at the next update date (the change is only visible then), and a portal with data privacy settings on (which legal basis HubSpot accepts for an unsubscribe).

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
