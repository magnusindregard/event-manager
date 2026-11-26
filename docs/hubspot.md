# HubSpot connector

*Draft, 20 November 2026; revised 24 November after the spike (runs 1–16): invitations through HubSpot's single-send API, and cleanup of the contacts that makes marketing. Milestone 1 (connection) built 21 November. Issue #95, part of epic #9. Builds on [docs/registration.md](registration.md). Decisions: [ADR 0017](adr/0017-hubspot-connector.md), [ADR 0008](adr/0008-events-and-webhooks.md).*

## Goal

Let an account connect its HubSpot portal, so that:

- **contacts, events and attendance show up in HubSpot**, for segmentation, reporting and the contact timeline;
- an event can have its **invitations and reminders sent through HubSpot**, in the client's own email design, one email per guest through HubSpot's single-send API. The platform keeps sending the transactional emails;
- the platform **takes back what sending through HubSpot does to the portal**: contacts it created are deleted, contacts it made marketing contacts are set back, and in the meantime none of them get the client's other marketing;
- a **HubSpot list can be the source of an event's guest list**, instead of a CSV exported from HubSpot.

The platform stays the source of truth for invitations, RSVPs and registrations. HubSpot gets copies and sends emails for the platform; nothing in HubSpot changes a registration.

## Scope

### In

- **Connection**: our own HubSpot app, OAuth, one portal per account, connect and disconnect from the admin.
- **Contacts**: upsert of invited guests and (if the account opts in) open-registration attendees, with name, email and locale, remembering which contacts the platform created.
- **Marketing events**: one per occurrence, with attendance (registered, cancelled, attended).
- **Segments**: static segments per event, kept in step with RSVPs, for the client's own lists and workflows; and the two segments the cleanup uses.
- **HubSpot sending** (Marketing Hub Enterprise): invitations, reminders (to guests who have not answered) and the welcome (the reminder before the event), sent per guest through the single-send API from the client's own template, with the platform's own email as fallback for guests HubSpot refuses.
- **Cleanup**: deleting contacts the platform created, setting contacts it made marketing back to non-marketing, and keeping them out of other marketing while they are marketing because of us.
- **Guest list import from a HubSpot list**, with the existing import and re-import rules.
- **Custom behavioural events** for portals on Marketing Hub Enterprise.
- Sync log in the admin, with retries, dead letter and replay.

### Out, and how this prepares for it

| Out of scope | Prepared by |
|---|---|
| Marketplace listing | The app is a developer platform project app; private distribution now (up to 10 portals), switch distribution to marketplace and certify when we pass that |
| HubSpot sending on portals without Enterprise | The platform sends the invitations there; mirroring, segments and list import work on every plan |
| Client workflows and automated emails | Segments and custom events are what a client's own workflow would enrol on. The only workflow the platform makes is its own, for the cleanup |
| Transactional emails from HubSpot (confirmation with QR, changes, cancels) | They stay in the platform (ADR 0010); the account's own template comes with #100 |
| Live sync of a guest list from a HubSpot list | "Refresh from HubSpot" re-runs the import; the list is remembered on the event |
| Anything flowing from HubSpot into registrations | RSVPs only happen on our pages; HubSpot never writes back |
| Contacts the client has taken into use | The cleanup leaves them (kept, with the reason in the sync log); the client is the controller of their portal |
| Companies, deals, tickets | Contacts only |

## Connecting

### The app

We own one HubSpot app on HubSpot's developer platform (built and deployed with the HubSpot CLI, kept in `integrations/hubspot-app/`). Distribution is **private**: HubSpot lets such an app be installed in up to 10 portals without marketplace review. The app's client id and secret are platform secrets in Key Vault.

### OAuth

1. Settings → Integrations → **Connect HubSpot** (owner only). `POST /v1/integrations/hubspot/authorize` returns HubSpot's install URL with a signed `state` (account, user, ten-minute expiry; HMAC with a key derived from the app's client secret, so no table), and the admin sends the browser there.
2. The portal admin picks the portal and approves the scopes. **Optional scopes are locked until a portal admin allows them in the app's admin settings** (run 15); the connection page says so before the button, with a link to HubSpot's help.
3. HubSpot sends the browser back to the **admin's** callback page, `<admin>/integrations/hubspot/callback`, which posts `code` and `state` to `POST /v1/integrations/hubspot/callback` with the signed-in owner's own token. The API refuses a `state` for another account or started by another user, so a link someone else started cannot connect their portal to your account, or yours to theirs. It then exchanges the code, reads the portal id and granted scopes, and stores the refresh and access token encrypted. An install missing a required scope is refused and revoked again.
4. A setup job creates what we need in the portal (below); the backfill comes with milestone 2.

**Disconnect** offers **Clean up and disconnect** (see Cleanup) or a plain disconnect. Either deletes our tokens and mappings and stops all sync; a plain one leaves what we wrote in HubSpot, and the admin says how many contacts are still marketing because of us. Links in HubSpot emails already sent are the platform's own invitation links and keep working.

A token HubSpot refuses (app uninstalled, access revoked) sets the connection to `needs_reconnect`: sync pauses, nothing is dropped, and the admin shows a banner.

### Scopes

| Scope | For | Required |
|---|---|---|
| `oauth` | Install | Yes |
| `crm.objects.contacts.read`, `crm.objects.contacts.write` | Contacts, and deleting the ones we created | Yes |
| `crm.lists.read`, `crm.lists.write` | Segments, guest list import | Yes |
| `crm.objects.marketing_events.read`, `crm.objects.marketing_events.write` | Marketing events and attendance | Yes |
| `content`, `marketing-email` | Template emails, per-event clones, single-send | Yes |
| `analytics.behavioral_events.send`, `behavioral_events.event_definitions.read_write` | Custom behavioural events | Optional (Enterprise) |
| `communication_preferences.read_write`, `communication_preferences.statuses.batch.read`, `communication_preferences.statuses.batch.write` | Subscription types: the event type picker, and keeping temporary marketing contacts out of other marketing | Optional; needed for HubSpot sending |
| `automation` | The workflow that sets contacts back to non-marketing | Optional; needed for HubSpot sending |

Optional scopes are only granted where a portal admin allowed them. The connection records what was granted, and features follow from that: **HubSpot sending is offered only with all four cleanup scopes**, since sending without the cleanup would leave marketing contacts behind. The list lives in `packages/hubspot/src/index.ts` (`BEHAVIOURAL_EVENT_SCOPES`, `CLEANUP_SCOPES`) and must match the app definition in `integrations/hubspot-app/` (a test checks).

### What HubSpot's plans allow

| | Any Marketing Hub plan | Marketing Hub Enterprise |
|---|---|---|
| Contacts, marketing events, attendance, segments, list import | ✓ | ✓ |
| Cleanup of contacts the platform created | ✓ | ✓ |
| HubSpot sending (single-send API) | – (the platform sends) | ✓, with the cleanup scopes |
| Custom behavioural events | – | ✓ |

The account details do not show the Marketing Hub tier (run 1), so the connection page finds out by a capability check after connecting (listing single-send emails, and a send the platform can tell apart from a plan refusal), so nobody discovers it at send time.

### Setup in the portal

Idempotent, rerun from the admin ("Repair setup"):

- Custom event definitions, if the behavioural event scopes were granted.
- With the cleanup scopes: the static segments **`EM · Temporary marketing contacts`** and **`EM · Set to non-marketing`**, and the workflow **`EM · Set to non-marketing`**: a contact workflow enrolled on that segment (`filterType: IN_LIST`), re-enrolling, with the action *Set marketing contact status* (`actionTypeId 0-31`, `marketableType: NON_MARKETABLE`), enabled. Run 16 created it, switched off, through the automation API. The setup does the same and then switches it on with a separate update, recording the workflow's id in between: on staging, HubSpot refused to create it switched on ("Invalid request to flow creation"). The update sends the whole flow back with `isEnabled: true`, its `id` and `revisionId` included (without `id` HubSpot answers 404 "Existing CRM object not found"), leaving out `createdAt`, `updatedAt` and `dataSources` as HubSpot's guide says. "Repair setup" switches on the recorded workflow, or recreates it if it is gone.
- A check that our token reaches the connected portal (`/account-info/v3/details`). Milestone 1 created the property group **Event manager** with `em_guest_key` instead; milestone 2 removed that, along with the `crm.schemas.contacts.write` scope, and leaves the property in portals that have it.

## Contacts

### What we write

| Property | Value |
|---|---|
| `email` | Guest email, the match key |
| `firstname`, `lastname` | Split from the guest name; only written if empty in HubSpot, never overwriting the client's data |
| `hs_language` | Not written yet: HubSpot's language codes differ from the platform's locales (open question 4) |

Nothing else. **No event, invitation or RSVP data on the contact**: a contact can be invited to several events at the same time, and single-valued properties would overwrite each other. Per-event state lives in segments, marketing event attendance and custom events. Form answers never leave the platform. The personal invitation link goes only into the single send (below), never onto the contact.

Contacts are matched on the HubSpot record id when we have one (`external_contact_id` from a HubSpot import, or our own mapping), else on email. Upserts are batched: a keyed job per contact with a short delay, collected into batch calls, which keeps us inside HubSpot's rate limits during an import of thousands of guests. The upsert's `new: true` tells the platform it created the contact, which it records for the cleanup.

Who is synced is an account setting: invited guests (default on) and open-registration attendees (default off).

## Marketing events and attendance

- **One marketing event per occurrence**: `externalAccountId` = account id, `externalEventId` = occurrence id, name (the event's title in the account's default locale), start and end, organiser (account name), type (`In person`), and the event's external URL when it has one (the platform has no public event page of its own).
- Created when the event is published, updated on `event.changed`, `occurrence.changed` and `occurrence.relocated`, marked cancelled on `occurrence.cancelled` and `event.cancelled`, restored when restored.
- **Attendance** by email: `register` on `registration.confirmed`, `cancel` on `registration.cancelled` and when moved to another occurrence (with `register` on the new one), `attend` on check-in when scanning lands (#7). Waitlisted and offered registrations are not registered until confirmed.
- HubSpot records attendance in the background: it shows in reads about 30 seconds after the call (run 17), so the platform never reads it back to confirm a call.
- Marketing events work on every HubSpot plan and show on the contact's timeline, which covers "did this person come to our events" without Enterprise. Deleting a contact we created (Cleanup) takes its attendance off the timeline.

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

The platform keeps static segments in the portal, named `EM · …`. HubSpot sending does not use them (it is per guest); they are for the client's own lists, reports and workflows, and for the cleanup:

| Segment | Members | For |
|---|---|---|
| **`EM · <event> · Awaiting reply`** | Sent an invitation, not accepted or declined | The client's own follow-up |
| **`EM · <event> · Confirmed · <occurrence>`** | Confirmed registrations of that occurrence | The client's own follow-up and reporting |
| **`EM · Temporary marketing contacts`** | Contacts that are marketing contacts because of us | For the client to exclude from their own lists and workflows (Cleanup) |
| **`EM · Set to non-marketing`** | Contacts being set back to non-marketing | Enrols them in our workflow (Cleanup) |

### Kept in step under the hood

An outbox handler updates memberships on every change that affects them: `invitation.sent`, `invitation.declined`, `registration.confirmed`, `registration.cancelled`, `registration.changed` (moved to another occurrence), `registration.waitlisted` and `registration.offered`. It does not read the change from the event: it works out the guest's memberships again from the platform's own state and marks a `segment_member` row dirty only where that differs from what HubSpot was last told, so a replayed or out-of-order event changes nothing. Changes are collected in the account's keyed sync job with a few seconds' delay and applied as batch add and remove calls (250 contacts per call), so a busy RSVP hour costs a handful of calls, not one per guest. A member waits until HubSpot has the contact.

List names are unique in a portal, so the second event with the same title gets `… (2)`. A list of that name the platform does not know is left alone, including our own from an earlier connection.

A nightly reconcile (04:00 UTC, after retention) first works out every event's memberships again, then reads each segment, compares it with the platform's own list and fixes the difference, which catches failed updates, guests removed from a guest list (which emits nothing), changed sync settings and hand edits in HubSpot; the sync log reports what it fixed. A guest whose contact could not be synced (an invalid email by HubSpot's rules, a sync error) is flagged in the guest list, never silently left out.

The segments are ours: renaming them in HubSpot is fine, editing their members is undone by the next reconcile, and deleting one makes the platform create it again (with every member). An event's segments are deleted when the event is archived, and an occurrence's Confirmed segment when the occurrence is deleted; one a sent email uses cannot be deleted (run 4), so it stays in HubSpot and the platform lets go of it.

## HubSpot sending

### Choosing the channel

Event setting **Invitations and reminders sent from**: *the platform* (default) or *HubSpot*, offered when the portal has Enterprise, the cleanup scopes and an event subscription type (below). It covers the invitation, the reminder and the welcome. Everything else stays in the platform: registration confirmation with the QR code, changes, cancellations, moved and cancelled occurrences, and waitlist emails.

Choosing HubSpot shows, before anything is sent, how many of the event's guests are not marketing contacts yet and would become ones, with the billing note from the Cleanup section.

The channel can change until the first invitation is sent; after that it is locked, so one event never mixes two senders for the same email (except the per-guest fallback below).

### The event subscription type

The account picks the **subscription type for event emails** in Settings → Integrations, for example "Invitasjoner og arrangementer". Every HubSpot email the platform sends uses it, and nothing else may: the cleanup unsubscribes our temporary contacts from every other type. The platform warns when the portal's other emails use the event type, and when a template uses another type.

### Template emails

The account chooses a **default single-send email per kind** (invitation, reminder, welcome) in Settings → Integrations, picked from the portal's emails of type `MARKETING_SINGLE_SEND_API` (run 10). An event can choose others. A template is an email the client designs in HubSpot and saves for the single-send API, with the event subscription type, and with placeholders as literal text, typically as button URLs:

| Placeholder | Becomes |
|---|---|
| `[[em:invitation_link]]` | `<attendee host>/i/{{ custom.invitation_token }}` |
| `[[em:manage_link]]` | `<attendee host>/m/{{ custom.manage_token }}`: the guest's manage page with the QR code (for the welcome) |
| `[[em:event_link]]` | The event's external URL (its page on the client's site), else the attendee site |

The template can also use the custom properties every send carries: `{{ custom.event_title }}`, `{{ custom.event_date }}`, `{{ custom.event_place }}` and `{{ custom.guest_name }}`, so one template can serve every event; the welcome's `event_date` and `event_place` are those of the guest's own occurrence. The platform warns when an invitation or reminder template has no `[[em:invitation_link]]`, a welcome template no `[[em:manage_link]]`, or a template another subscription type than the event type.

The setup (and "Repair setup") reads the portal's emails: those of type `MARKETING_SINGLE_SEND_API` not named `EM · …` are the templates to choose from, and the client's other emails that use the event type are named as a warning. A template made in HubSpot after connecting shows after "Repair setup".

### The event's own emails

When the channel is set to HubSpot, the platform makes the event's emails from the templates:

1. **Clones** the template (a clone stays a single-send email, run 10).
2. Names it `EM · <event> · Invitation` (`· Reminder`, `· Welcome`), and sets subject and preview text (a module in the content, run 1) from a form prefilled from the event.
3. Replaces the **placeholders** with the event's links.
4. **Publishes** it. A draft cannot be sent (run 7); publishing sends nothing, and HubSpot accepts sends some seconds later.

The guest list links to each email in HubSpot for design changes. Subject and preview text can be changed from the platform until the first send. One email per kind, the welcome included: its custom properties carry the guest's occurrence, so one welcome serves every occurrence. The welcome is made only when the event has a reminder before it. Making an email again (a new template, subject or preview text, or the event's title) replaces it until it has been sent from. Choosing the platform again before anything was sent deletes the event's emails. The event's emails are deleted when the event is archived (a published single-send email can be deleted, runs 7–14); the sends stay on the contacts' timelines.

### Sending to a guest

"Send invitations", the reminder and the welcome (see "When emails go out") pick guests with the same rules as the platform's own sending. Per guest, a keyed job:

1. **Before the contact's first HubSpot send**: upserts the contact, reads its marketing status and subscription statuses, and unsubscribes it from every type but the event type if it is not a marketing contact already (Cleanup).
2. **Decides the channel for this guest**. The platform sends instead, without asking HubSpot, when the address has a `+` (HubSpot refuses those, run 12) or the contact is unsubscribed from the event type or from all email: a refused send still makes the contact a marketing contact (runs 7–9), so it is never tried.
3. **Sends**: `POST /marketing/email-campaigns/2026-09/single-send` with the event's email, the guest's address, `sendId` = the invitation send's id, and the custom properties, `invitation_token` being the invitation's own token from `registration/tokens.ts`.
4. **Reads the result** from `GET /marketing/v3/email/send-statuses/{statusId}`:
   - `SENT`: one `invitation_send` with `channel: "hubspot"`, which emits `invitation.sent.v1`.
   - `IDEMPOTENT_IGNORE`: the same `sendId` was sent before, whichever request HubSpot processed first (run 14); treated as sent.
   - Anything else (`VALIDATION_FAILED`, `PREVIOUSLY_UNSUBSCRIBED_*`, `PREVIOUSLY_BOUNCED`, …): the platform sends its own email, and the guest list says why.
   - No answer yet. Once HubSpot has taken a send, only HubSpot's answer settles it, and the platform never sends a second email for it. The send keeps HubSpot's status id and the portal that took it, and always goes back to HubSpot, whatever the event's channel is now; a taken send also settles the channel. While that portal is connected, a send still processing is read again every 10 minutes, for up to two days. If our access to that portal goes, or another portal is connected, the send is **unresolved**: out of the queue, shown on the guest list with why, and staff may send again. Reconnecting the portal that took it reads it again; a refusal found then is recorded and not followed by the platform's email, as staff were told to resend. Whether the guest still needs the email (no answer yet, event published; for the welcome, registered and before the start) decides only a new email, the first send or the platform's fallback, never whether a taken send's result is read: a guest who answers, or cancels, while HubSpot works on it gets nothing new from the platform if HubSpot did not send it. That is read again after the call to HubSpot, just before the platform would send, and a fallback welcome waits for the reminder time if the occurrence moved later meanwhile. HubSpot's refusal is then kept (`reminder_refusal`, migration 0031), so the platform sends its welcome at that time without asking HubSpot again, even if HubSpot has been disconnected since. The same holds for any fallback: HubSpot's refusal is kept before the platform's email is tried (for an invitation in `fallback_reason`), so a retry of that email needs nothing from HubSpot. A welcome HubSpot has not settled two days after taking it is left unresolved (`reminder_status_at`, migration 0030), as an invitation is two days after it was requested.

Sends are spread over jobs at a steady rate per second, to stay within HubSpot's rate limits (the daily limit of 1,000,000, run 7, is not the constraint).

### When emails go out

The single-send API sends at once and has no scheduling, so **the platform owns all timing**, as it does for its own emails. Nothing is scheduled in HubSpot. Each send decides its channel when it runs, with the rules in "Sending to a guest", so the timing below is the same whichever channel the event uses.

The three kinds, in the words used with the client:

| Kind | In the platform | When it goes out |
|---|---|---|
| **Invitation** | `invitation` send | When staff send it ("Send invitations") |
| **Reminder** (the RSVP reminder) | `reminder` send | When staff send it, to guests who have not answered |
| **Welcome** (the reminder before the event) | The registration reminder (`registration.reminder`) | Scheduled: `reminderMinBefore` before the guest's occurrence starts |

So only the welcome is scheduled, and that is enough for now.

**The welcome** keeps the platform's existing pattern (`apps/worker/src/reminder.ts`): one job per registration, keyed by it and set to run at the welcome time. Anything that moves the time queues it again under the same key, which replaces it: a new registration, a moved occurrence, the event (re)published, a changed reminder setting. The job checks the time and the registration again when it runs, so a stale job reschedules itself or does nothing. On the HubSpot channel the job sends the event's welcome email, per guest as above, with `welcome-<registration>` as `sendId`; the welcome links to the manage page, which shows the QR code. Without a ready welcome email the platform sends its own welcome, and the registration records which channel sent it and why (`reminder_channel`, `reminder_detail`).

**Invitations and reminders** go out when staff send them, as today: `requestSends` logs one send per guest and queues one job per send, which runs at once.

Every send keeps its own `invitation_send` row (or the registration's reminder mark), and its id is the `sendId`, so a retried or replayed job never sends twice, at our end or HubSpot's. A guest becomes a marketing contact when an email goes, not when it is scheduled.

**Later: staff-scheduled sends.** "Send the invitations on Tuesday at 09:00" or "remind those who have not answered on Friday" would queue the **schedule**, not the sends: a `registration.send_schedule` row (event, kind, time, audience rule, who scheduled it, status) with one keyed job for its time. Only when it runs does it work out who the email goes to (guests who answered meanwhile get no reminder, guests added since get the invitation) and fan out per guest as above. Changing or cancelling a schedule changes the row and re-keys its job; nothing per guest has to be undone. The guest list would show what is scheduled, with Edit and Cancel, for both channels. Not needed now.

### Delivery

The guest list shows "Sent via HubSpot", or "Sent by the platform" with HubSpot's reason. Opens and clicks stay in HubSpot, where the send shows on the contact's timeline; HubSpot does not keep the HTML that was sent. HubSpot does not deliver to contacts unsubscribed from the event type, which the platform checks before sending.

## Cleanup after HubSpot sending

When HubSpot sends invitations, the platform puts people into the client's portal as marketing contacts who would not otherwise be there. The platform takes that back afterwards, and keeps those people from getting the client's other marketing in the meantime:

- **Contacts the platform created are deleted.**
- **Contacts the platform turned into marketing contacts are set back to non-marketing.**
- **While they are marketing contacts because of us, they get no other marketing email** from the portal: no newsletters, no automated emails, nothing but the event's own emails.

Contacts that were marketing contacts before the platform touched them are the client's: the platform changes nothing about them, neither during nor after.

### What HubSpot allows

| Need | HubSpot | Source |
|---|---|---|
| Delete a contact | `DELETE /crm/v3/objects/contacts/{id}` (restorable for 90 days in HubSpot), or the GDPR delete for a permanent one | Runs 1–14 |
| Set a contact to non-marketing | **Not through the API**: `hs_marketable_status` is read-only (run 5), and a `PATCH` answers `200` and changes nothing (run 15). Only in the UI (Marketing contacts → Clean up contacts, or the contacts index) or with the workflow action *Set marketing contact status* | HubSpot knowledge base |
| When non-marketing takes effect | At the portal's next **update date**: the renewal day each month for monthly plans, the first of each month for yearly ones. Until then the contact counts as marketing (`hs_marketable_until_renewal` is true) | HubSpot knowledge base |
| What it costs | The marketing contact tier goes up automatically when exceeded and never down before renewal. Deleting a marketing contact frees capacity, but HubSpot does not say whether at once or at the update date | HubSpot knowledge base |
| Keep a contact from other marketing | Every marketing email has a **subscription type**, and HubSpot does not send it to a contact unsubscribed from that type. The v4 subscriptions API sets a contact's status per type (`SUBSCRIBED`, `UNSUBSCRIBED`, `NOT_SPECIFIED`); in portals with data privacy settings on, every write needs `legalBasis` and `legalBasisExplanation` | v4 subscriptions guide |
| Unsubscribe from everything | `…/statuses/batch/unsubscribe-all` exists, but would block the event's own emails too; there is no "all but one" | v4 subscriptions guide |

So deleting is in our hands; setting back to non-marketing needs a workflow in the portal; keeping people from other marketing is done through subscription types.

### Remembering what the platform did

The cleanup can only undo what the platform knows it did, so it records it in `integrations.contact_state` (see Data model): whether it created the contact at the contact's first sync, and the rest **before the first HubSpot send to the contact**.

| Field | Meaning |
|---|---|
| `created_by_us` | No contact had the email when the platform first synced it (the upsert's `new: true`, run 15) |
| `marketable_before` | `hs_marketable_status` before the first send |
| `subscriptions_before` | The contact's status per subscription type before the platform changed any |
| `subscriptions_set` | The types the platform unsubscribed |
| `marketing_by_us_at` | When a send of ours made the contact a marketing contact |
| `needed_until` | When the platform last needs the contact, for a HubSpot send or mirroring (below) |
| `cleanup_status` | `none`, `pending`, `deleted`, `restored`, `kept` (with reason), `failed` |

A contact that was already a marketing contact gets `marketable_before: true` and nothing more: the platform does not touch its subscriptions and never cleans it up.

### While a guest is a marketing contact because of us

1. **A subscription type of its own for event emails.** The account picks one in Settings → Integrations, for example "Invitasjoner og arrangementer". The platform's HubSpot emails use only that type, and the setup guide says no other email may use it. The platform warns if the type is also used by emails it did not make (it can list the portal's emails and their `subscriptionDetails`).
2. **Unsubscribe from every other type** before the first send, for contacts with `created_by_us` or `marketable_before: false`: the platform reads the portal's subscription types and sets every one except the event type to `UNSUBSCRIBED`, recording what it changed. Every marketing email, including the client's automated emails and newsletters, carries a type, so this keeps the guest out of all of them.
3. **New subscription types** created in the portal later are not covered by step 2. The nightly reconcile reads the types again and unsubscribes our temporary contacts from new ones.
4. **A static segment `EM · Temporary marketing contacts`** holds all of them, for the client to exclude from lists and workflows as well. This is belt and braces; the subscription types are what actually stops the emails.

Legal basis: the sandbox needed none (run 15). In a portal with data privacy settings on, each unsubscribe is written with a legal basis (`LEGITIMATE_INTEREST_OTHER` unless HubSpot asks for another) and the explanation "Event manager: temporary contact for an event invitation; not for other marketing".

### When a contact is no longer needed

`needed_until` is the latest of, over all the contact's invitations and registrations in the account: the end of the occurrence plus a grace period (default 7 days, an account setting), so the welcome and any later email go out first; and the time of any email still scheduled to the contact (staff-scheduled sends, when they come). It moves when the guest is invited to another event, registers for another occurrence, or an event is moved. A guest who declines and has nothing else open is needed until the invitation's last reminder would have gone, which in practice is soon.

A nightly job picks up contacts whose `needed_until` has passed.

### Cleaning up a contact

**Created by us:**

1. Check that the client has not taken the contact into use since: no associations (companies, deals, tickets), no owner, no form submissions, no list memberships other than our own segments, and no marketing event attendance other than our events. If any of these holds, the contact is the client's now: treat it as "turned into marketing by us" below and mark it `kept (in use)` in the sync log.
2. Otherwise delete it, and drop the platform's mapping. The platform's own registration data is unaffected.

**Turned into marketing by us** (`marketable_before: false`):

1. Put the subscriptions back to `subscriptions_before`, only for the types the platform changed, and only where the contact has not changed them since (it is the guest's own choice then).
2. Add the contact to the static segment `EM · Set to non-marketing`. A workflow in the portal, enrolled on that segment, runs *Set marketing contact status → non-marketing* and removes the contact from the segment. The status changes at the next update date.
3. Remove the contact from `EM · Temporary marketing contacts`.

While the workflow is off or missing, setting back fails for the contact, which stays pending and is tried again after "Repair setup"; "Clean up and disconnect" then stays connected. The workflow lives in the portal, but the platform creates it during setup through the automation API (scope `automation`; run 16 showed it can) and checks it on "Repair setup". The connection page checks that the segment empties itself; contacts left in it for more than a day show as a warning.

**Already marketing before** (`marketable_before: true`): nothing.

**Created by us, never sent to through HubSpot** (contacts made only for mirroring, on events with the platform channel): non-marketing all along, so nothing to set back. They are deleted the same way, after the same checks, unless the account turns off "Delete contacts the platform created" for mirrored contacts (default on). Deleting them takes their marketing event attendance off HubSpot's timeline; that is the trade the account makes.

**Anonymised in the platform**: a contact the platform created is cleaned up at once, whatever its `needed_until`. A contact the client keeps is theirs.

### Billing, honestly

A marketing contact counts for the billing period it was marketing in, and setting it back only takes effect at the next update date. So each guest invited through HubSpot costs the client a marketing contact for at least the rest of that period, and the portal's tier can go up for the year if a big invitation pushes it over. The admin says so when the HubSpot channel is chosen, with the number of guests who are not marketing contacts yet, before anything is sent. Cleaning up promptly keeps the count from growing period after period; it does not undo the current one.

### Disconnecting

Disconnect offers **Clean up and disconnect**: it runs the cleanup at once for every pending contact (deleting, restoring subscriptions, queuing the non-marketing workflow), waits for it to finish, then disconnects. A plain disconnect leaves the contacts as they are, and the admin says how many. An owner can cancel "Clean up and disconnect" until it has finished; what it already did in the portal stays done. If the cleanup cannot run at all (HubSpot refuses our access), the request is dropped with why in the sync log, and reconnecting clears any request left from the old install.

## Guest list from a HubSpot list

The guest import (`GuestImport.tsx`) gains a source: **From HubSpot**.

1. Pick a list or segment from the portal (searched by name, `POST /crm/v3/lists/search`; the platform's own `EM · …` segments are left out).
2. A worker job (`hubspot.guest_list`) fetches its members (memberships, then contacts in batches of 100: email, first and last name, `hs_language`, record id) into the existing staging (`registration.guest_import`), with the columns Email, First name, Last name, Language and Contact ID, which the import's header guesses map by themselves. HubSpot's language is turned into one of the account's locales (`no` and `nn` → `nb`, `en-us` → `en`), or left empty, so it never makes a row fail. A list can be thousands of contacts, so this runs in the background; the admin waits for it and then shows the mapping.
3. Preview and commit as for a file: row errors (a contact with no email shows as one), duplicates, re-import matched on email, removals listed and never silent.
4. `external_contact_id` is set to the HubSpot record id. These contacts existed before, so the contact sync records that the platform did not create them, and the cleanup never deletes them.

The list is remembered on the event (`integrations.guest_list_source`); **Refresh from HubSpot** fetches it again and imports with the same rules. Asking again replaces a fetch nobody committed. There is no live sync.

## Data model

New module `integrations` (ADR 0001), schema `integrations`:

- `connection`: `tenant_id`, `provider` (`hubspot`), `status` (`active`, `needs_reconnect`, `disconnected`) and `status_reason`, `external_account_id` (portal id), `scopes[]`, `settings` (who to sync, the event subscription type, default templates, the cleanup's grace period and whether mirrored contacts are deleted), `setup_status`/`setup_error`/`setup_at`, `connected_by`, `connected_at`, `disconnected_at`, and `generation`, bumped on every connect and disconnect: the worker writes tokens, setup results and `needs_reconnect` back only to the generation it loaded, so a job that outlives a reconnect to another portal cannot touch it. One row per account and provider, kept on disconnect. Features (`customEvents`, `sending`) are derived from the scopes and capability checks, not stored. Reconnecting the same portal reuses the row; another portal needs a disconnect first.
- `credential`: refresh and access token as one ciphertext under the account's data key, bound to the connection id, plus the access token's expiry.
- `sync_item` (milestone 2, built): one row per thing kept in step, per connection: `kind` (`contact` by email, `marketing_event` by occurrence, `attendance` by occurrence and email, `segment` by event and role (`<event>:awaiting`, `<event>:confirmed:<occurrence>`) and `segment_member` by segment and email (milestone 3); `local_key`, `remote_id`, `data` (what it should be), `created_by_us` (contacts, from the first upsert's `new`), `synced_state` (attendance), `dirty`, `attempts`, `last_error`, `last_synced_at`. The row is both the id mapping and the pending change; disconnecting deletes the connection's rows.
- `contact_state` (milestone 4, built): per contact, what the platform did to it, with the fields in "Remembering what the platform did". A row is written before the first HubSpot send, or by the nightly cleanup for contacts the platform created for mirroring. `prepared_at` (migration 0028) is set only once the preparation's HubSpot writes are all done; until then a retried send finishes them from what was recorded before it sends. The first snapshot of a contact wins, so two sends preparing the same address at once both work from the one taken before anything changed. Once the cleanup has deleted or set back a contact, the row goes; `kept` rows stay so a contact the client took into use is never touched again, and `failed` rows are tried again nightly. `cleanup_status` is thus `none` (marketing before: never cleaned up), `pending`, `kept` or `failed`.
- The **sync log** is `sync_item` itself (built): each item's state, attempts and HubSpot's last answer is what the log shows, and retrying resets the item. An item refused five times is given up (the dead letter) until an owner retries it or it changes again. A separate `delivery` table per outbox event and handler, as first planned, is left for outgoing webhooks (#94), which need delivery per event; the connector does not.

Changes elsewhere:

- Envelope encryption moves from `registration/secrets.ts` to `shared/secrets.ts` (`encryptJson`/`decryptJson` with a context string), and `registration.data_key` to `platform.data_key`, with the stored format unchanged, so both modules use it.
- `event_sending` (milestone 5, built): per event, `channel` (`platform` | `hubspot`), template overrides and subject and preview text per kind, and `marketing_check` (what the last count of the guests in HubSpot found). In the integrations module rather than on `catalog.event`, as first planned, since only the connector reads it; the worker's send jobs ask `integrations.eventChannel`.
- `event_email` (milestone 5, built): the event's own email per kind in the connected portal: the template it was made from, HubSpot's id, name, subject, preview text, `status` (`pending`, `ready`, `failed`) with the error and warnings, and `first_sent_at`, after which it is settled. A table of its own rather than a `sync_item` kind: an email is made once and then locked, not kept in step. Disconnecting deletes the connection's rows; the emails stay in the portal.
- `guest_list_source` (milestone 6, built): per event, the HubSpot list its guests come from (`list_id`, `list_name`), and the last fetch: `status` (`fetching`, `ready`, `failed`), the staged `import_id`, `error`, `member_count`, who asked and when.
- `registration` (milestone 5, built): `invitation_send` gains `channel` (`platform` | `hubspot`), `provider_status_id` (HubSpot's status id, so a retried job reads the result instead of sending again) and `fallback_reason`; the registration gains `reminder_channel`, `reminder_status_id` and `reminder_detail` for the welcome.

## Worker

- `packages/hubspot`: the `HubSpotClient` interface, the real `HttpHubSpot` and `FakeHubSpot` (like `Mailer` and `FakeMailer`), shared by the API (OAuth) and the worker. The worker's `withHubSpot` (`apps/worker/src/hubspot/session.ts`) refreshes a token about to expire, and once more if HubSpot refuses one anyway; only a refused refresh sets `needs_reconnect`. Since milestone 6 this is `integrations.withProvider` in the domain, with HubSpot's part (`hubspotAuth` in `packages/hubspot`), so the API uses it too, to search the portal's lists. `429` and `5xx` fail the job so graphile-worker retries with backoff; honouring rate limit headers within a job comes with the batch calls in milestone 2.
- One `InternalHandler` (`apps/worker/src/hubspot/sync.ts`) subscribed to `invitation.sent`, `registration.*`, `event.*`, `occurrence.*` and `integration.connected`/`resync_requested` (and `admission.*` when #93 lands). It only marks `sync_item` rows dirty and queues one keyed `hubspot.sync` job per account, five seconds later (`preserve_run_at`, so a stream of changes cannot postpone it). The job pushes contacts (100 per batch), then marketing events, then attendance only for contacts and events HubSpot already has (recording it by email would otherwise create the contact behind our back), and queues itself again while it makes progress. A refusal of an item is recorded on it and retried by later runs, up to five times.
- Jobs for HubSpot sending: one per guest and email (prepare the contact, send, read the result, fall back), keyed on the invitation send so a retry never sends twice; `sendId` makes HubSpot's side idempotent too.
- Nightly: reconcile the segments (04:00 UTC), then the cleanup (04:30 UTC): unsubscribe temporary contacts from new subscription types, check that the cleanup workflow is enabled and its segment empties, and clean up contacts whose `needed_until` has passed. `needed_until` is worked out afresh each night from the guest's invitations and registrations, so moves and new invitations need no bookkeeping.
- Idempotent on outbox event id (ADR 0008): replaying an event never registers twice or sends twice.
- Retries with backoff: a refusal of HubSpot as a whole (rate limit, outage) fails the job, which graphile-worker retries; a refusal of an item is recorded on it and retried by later runs, up to five times, then given up until an owner retries (`POST /v1/integrations/hubspot/sync/retry`) or it changes. "Resync" (`POST /v1/integrations/hubspot/resync`) marks everything again, as after connecting. The log is `GET /v1/integrations/hubspot/sync`.
- **Backfill** after connecting and on **Resync**: published events with upcoming occurrences, their marketing events, attendance, guests and segments.

## Admin

- **Settings → Integrations**: connect and disconnect (with "Clean up and disconnect"), portal and plan features, which cleanup scopes are missing and how to allow them, who to sync, the event subscription type, default template emails, the cleanup settings and how many contacts are pending, "Repair setup", and the sync log: per kind how many items are in HubSpot, waiting and given up, when it last synced, what HubSpot refused and why, with "Try again" and "Resync everything" (built).
- **Event**: the channel setting, with how many guests would become marketing contacts, and on HubSpot, template overrides.
- **Guest list**: the event's HubSpot emails, their state and links; "Sent via HubSpot" or "Sent by the platform" with the reason in the send column; warnings for guests not synced and occurrences with no reminder email.
- **Guest import**: the "From HubSpot" source and "Refresh from HubSpot".

## Data protection

- Syncing is opt-in per account, with separate switches for invited guests and open-registration attendees. The client is the controller for what lands in their portal; we write only name, email, locale and event attendance, and invitation links travel only inside the single send.
- HubSpot sending makes guests marketing contacts in the client's portal, for the client's lawful basis to cover; the platform keeps them out of other marketing and undoes it afterwards (Cleanup). Subscription changes are written with a legal basis where the portal asks for one.
- Contacts the platform created are deleted after their last event, and at once when the platform anonymises the guest. Contacts the client keeps are theirs, and the client's own retention applies there; the setup guide says so.
- Disconnecting deletes our tokens and mappings, after an optional cleanup.

## Milestones

0. **Spike** on a HubSpot test portal: done, runs 1–16 (below).
1. **Connection**: integrations module, shared encryption, OAuth, setup job, Settings → Integrations. Built; the cleanup scopes were added as optional on 24 November.
2. **Contacts and marketing events**: contact sync recording who created each contact, marketing events and attendance, backfill, sync log. `em_guest_key` leaves the setup. *Built on 24 November: setup without the guest key, `sync_item`, the outbox handler and the batched sync job (contacts, marketing events, attendance including moves and cancels), backfill on connect, the sync log with "Try again" and "Resync everything" (API and admin). Left: `attend` with scanning (#7), and a run against the sandbox portal with the real client.*
3. **Segments**: per event, incremental updates and the nightly reconcile. *Built on 24 November: `segment` and `segment_member` in `sync_item` (migration 0024), membership worked out from the platform's state per guest on `invitation.sent`, `invitation.declined` and `registration.*` (and for the whole event on publish and backfill), batched adds and removes, unique names (`… (2)` when two events share a title), segments deleted on archive (kept if a sent email uses them) and remade when deleted in HubSpot, the nightly reconcile at 04:00 UTC (`hubspot:reconcile`) with what it fixed in the sync log. Left: flagging guests whose contact could not be synced in the guest list.*
4. **Cleanup**: `contact_state`, the event subscription type, unsubscribing temporary contacts from other types, the cleanup segments and workflow in setup, the nightly cleanup, "Clean up and disconnect". Before sending, which depends on it. *Built on 25 November: `integrations.contact_state` and the connection's `portal_setup` and `last_cleanup` (migration 0025); the settings for the event subscription type, the grace period and deleting mirrored contacts; the setup reading subscription types and making `EM · Temporary marketing contacts`, `EM · Set to non-marketing` and the enabled workflow (repaired when off or gone); `prepareForSend` in `apps/worker/src/hubspot/cleanup.ts`, which milestone 5 calls before a send; the nightly cleanup at 04:30 UTC (`hubspot:cleanup`) with new subscription types covered and the workflow checked; "Clean up and disconnect" (`POST /v1/integrations/hubspot/cleanup-and-disconnect`), which stays connected if any contact could not be cleaned up; and Settings → Integrations. Until milestone 5 sends, the only contacts it cleans up are those made for mirroring. Not tried against real HubSpot yet: the batch subscription read, the contact checks (`associations`, list memberships, marketing event participations by contact) and enabling a workflow through a v4 `PUT`.*
5. **HubSpot sending**: channel setting, single-send templates and the event's own emails, per-guest sends with fallback, reminders, client setup guide. *Built on 25 November: migration 0026 (`event_sending`, `event_email`, the send channel on `invitation_send` and the registration); the setup reading the single-send templates; the account's default template per kind and the event's channel, templates, subject and preview text (`GET`/`PATCH /v1/events/{id}/sending`, locked once an invitation has gone out), with the count of guests who would become marketing contacts (`POST …/sending/check`); the event's emails cloned, filled in and published (`hubspot.event_emails`), made again until sent from and deleted on archive; `apps/worker/src/hubspot/send.ts`, which the invitation, reminder and welcome jobs call: plus addresses and guests unsubscribed from the event type go to the platform untried, the contact is upserted (recording that the platform made it) and prepared for the cleanup, the send uses our own id as `sendId`, HubSpot's status id is kept before the result is read, a draft or an unfinished send retries the job, and a refusal (a `403` from a portal without Enterprise included) sends the platform's own email with the reason on the send; HubSpot sends spread at 5 per second; Settings → Integrations (default templates and their warnings) and the guest list ("Invitations sent from", the event's emails with links to HubSpot, "via HubSpot" or the platform's reason in the send column). Deviations: one welcome email per event, not per occurrence; the channel lives in the integrations module. Left: showing the welcome's channel in the admin; warning about the event type in templates chosen per event; a check after connecting that tells a portal without Enterprise apart before anyone chooses HubSpot (today: no single-send emails, or the first send's refusal); a run against the sandbox portal.*
6. **Guest list from HubSpot**. *Built on 25 November: migration 0027 (`integrations.guest_list_source`); `GET /v1/integrations/hubspot/lists?q=`, `GET`/`POST /v1/events/{id}/guest-source` and `POST …/guest-source/refresh`, and `GET /v1/guest-imports/{id}` for a draft staged in the background; the worker job that stages a list's members; "From HubSpot" in the guest import and "Refresh from HubSpot" on the guest list. Left: matching later contact syncs on the record id rather than email; choosing another property than `hs_language` for the language; a run against the sandbox portal.*
7. **Custom behavioural events** (Enterprise). *Set aside for now: issue #115.*

Depends on #93 (`admission.issued`, `reminder.due`) and #7 (`attend`). #94 reuses the `delivery` log.

### Setting up HubSpot sending (for the client)

1. In HubSpot, allow the app's optional scopes for subscriptions and automation (Settings → Integrations shows which are missing), and connect again if asked.
2. Make a subscription type for event emails only, for example "Invitasjoner og arrangementer", and choose it in Settings → Integrations. No other email of yours should use it; the platform warns if one does.
3. Design a template email per kind in HubSpot, with the event subscription type, and **save it for the single-send API**. Use `[[em:invitation_link]]` as the button's URL in invitations and reminders, `[[em:manage_link]]` in the welcome, and `[[em:event_link]]` for the event's page. Text can use `{{ custom.event_title }}`, `{{ custom.event_date }}`, `{{ custom.event_place }}` and `{{ custom.guest_name }}`. Then "Repair setup" in Settings → Integrations, and choose the templates there.
4. On an event's guest list, choose HubSpot under "Invitations sent from". Before sending, it says how many guests would become marketing contacts; each counts towards your plan for at least the rest of the billing period. The platform cleans up after the event (Cleanup above).
5. The event's emails appear in HubSpot as `EM · <event> · …`. Change their design there; subject and preview text from the guest list, until the email has been sent from.

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

**Runs 15–16, 24 November 2026**: the cleanup checks.

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

**Run 17, 24 November 2026**: marketing event attendance, read again over time.

| Question | Finding | What it means for the design |
|---|---|---|
| Does recorded attendance show up? | **Yes, about 30 seconds later**: straight after `register` and `attend` every read says `total: 0` (as in runs 1–6); on the next read, the breakdown by external ids, by HubSpot's `objectId` and by contact all show two records for the contact, the last `ATTENDED`. The event's own read carries no counters. `occurredAt` is the event's start, not the `interactionDateTime` we sent | HubSpot processes attendance in the background. The platform treats a `200` from the attendance call as done and never reads back to confirm; the nightly reconcile, if it checks attendance, reads it the next day |

### What the spike decided

HubSpot regular emails reach only guests who are already marketing contacts, which an app cannot create (runs 5–6). The options weighed on 23–24 November:

1. **Keep regular emails, with a client workflow** that makes our contacts marketing contacts.
2. **Split per recipient**: HubSpot sends to marketing contacts, the platform to the rest.
3. **Drop HubSpot sending, keep the rest**: the platform sends all invitations with account-branded templates (#100).
4. **Drop the integration** and build email templating in the platform.
5. **Single-send API** (runs 7–14), with the cleanup (runs 15–16).

[ADR 0017](adr/0017-hubspot-connector.md) was revised on 24 November to option 5, and the design above follows it; option 3 remains the default channel and the only one on portals without Enterprise. Milestone 1 holds; the guest key and the regular email drafts from the first version are gone.

Still open: a coded template; what a portal without Enterprise answers to a single-send; enabling the cleanup workflow and seeing a contact set to non-marketing at the next update date; a portal with data privacy settings on.

## Testing

- **Worker** (`apps/worker/test/hubspot.test.ts`, fake client): each outbox event gives the expected calls; replayed events change nothing; segment changes are coalesced; the nightly reconcile fixes a drifted segment; a HubSpot send records `created_by_us`, marketing status and subscriptions first, unsubscribes from other types, sends with `sendId`, logs one `invitation_send` with `channel: "hubspot"` and emits `invitation.sent.v1`; `IDEMPOTENT_IGNORE` counts as sent; a refused send falls back to the platform; plus addresses and unsubscribed guests never reach HubSpot; the cleanup deletes a contact we created, keeps one the client took into use, restores subscriptions and queues the non-marketing segment, and never touches a contact that was marketing before; a refused token pauses sync; `429` backs off.
- **Domain** (`packages/domain/test/acceptance/integrations.test.ts`): connection and encrypted credentials; contact state and `needed_until` across two events; anonymising a guest cleans up a contact we created.
- **API** (`apps/api/test/integrations.test.ts`): OAuth `state` checks and callback; owner-only connect; the channel offered only with Enterprise and the cleanup scopes; template and subscription type settings.
- **Spike** (`apps/worker/test/hubspot-spike.test.ts`): the spike runner against a fake HubSpot.
- **Contract tests** against recorded HubSpot responses for every endpoint we call (the spike's recordings are the start).
- **End to end** on a HubSpot test portal in staging: connect with the optional scopes, import a list, choose the HubSpot channel, send invitations, accept through the link in the HubSpot email, see *Awaiting reply* and *Confirmed* change and attendance on the marketing event, the welcome, then the cleanup after the grace period, and "Clean up and disconnect".

## Open questions

1. **Coded templates**: can placeholders be replaced as reliably in a coded single-send template as in a drag-and-drop one, or do we need a custom module in our app?
2. ~~**Two accounts, one portal**~~: decided in the review of PR #116: a portal has at most one live connection across accounts (a unique index, migration 0028), and the second account is refused without revoking the first account's install, so the cleanup never has to look across accounts.
3. **Open registration on HubSpot**: should open events (no invitations) also get the welcome from HubSpot, or is the HubSpot channel for invite-only events only?
4. **Locale**: write `hs_language` from the guest's locale, or leave language entirely to HubSpot?
5. **Mirrored contacts**: is deleting contacts the platform created only for mirroring the right default, given it takes their attendance off HubSpot's timeline?
6. **Deleting and billing**: does deleting a marketing contact free its place in the count at once or only at the update date? HubSpot's documentation does not say.
