# Registration – guest invitations and RSVP

*Draft, 16 November 2026. Builds on [docs/mvp.md](mvp.md). Decisions: [docs/adr](adr/README.md).*

## Goal

Let client staff run free events with registration in the platform instead of with free tickets at their ticket vendor:

- **Closed events** (the main need today): staff import a guest list exported from their CRM or MA tool, send personal invitations and see who has accepted.
- **Open events with limited places**: anyone can register until the event is full, then join a waitlist.

Both are the same model: open registration is the base, and *invite-only* is a restriction on who may register. This is also the foundation for ticketing: capacity pools, holds and admissions are built here, and offers, prices and payment are added on top later.

"Invitation" in this document means a **guest invitation**. Staff invitations (ADR 0012, worker provisioning) are a different thing; code uses `guest_invitation` or lives in the `registration` module to keep them apart.

## Scope

### In

- **Access policy** per event, overridable per occurrence: `open`, `invite_only`. `admissionMode` gains the value `registration`; `external` and `none` stay.
- **Capacity** per occurrence, as a rule effect, with an optional **overbooking** percentage.
- **Registration**: name, email, an optional guest ("I will bring a guest"), and the answers to the event's form. Confirmed at once; the confirmation email has a QR code and a link to change or cancel.
- **Waitlist** with automatic promotion and a claim deadline.
- **Guest list import** from CSV or XLSX, with column mapping, preview and re-import.
- **Invitations** sent by email from the platform, with personal links; CSV export of the links for clients who send from their own tool.
- **Form fields** chosen per event by the event manager.
- **Hosted attendee pages** for registering, accepting or declining, changing and cancelling.
- **Notifications** when an occurrence with registrations is moved or cancelled.
- **Door list**: printable and exportable list per occurrence.
- **Retention**: registrations anonymised 12 months after the occurrence; sensitive answers deleted sooner.

### Out, and how this prepares for it

| Out of scope | Prepared by |
|---|---|
| CRM / MA sync | Optional `externalContactId` on every invitation from the import; `registration.*` and `invitation.*` domain events in the outbox |
| Validator app, QR scanning | Admissions are created per registration and the QR code holds a signed admission token, so the validator needs no backfill |
| Ticketing (offers, prices, payment) | Capacity pools and holds per ADR 0003; registrations hold capacity the same way a basket will |
| Registration on the client's own website | Attendee endpoints are a versioned API behind the hosted pages, so they can be opened to client frontends later |
| Guest names, more than one guest | Party size is a number; the guest checkbox sets it to 2 |
| One invitation, several occurrences | Not planned: invitations to one specific occurrence are set up as a separate event |
| Shared capacity across occurrences or spaces | Pools are per occurrence now; `capacity_pool` already has an id that offers can reference |

## Data model

New module schemas: `inventory` (capacity pools, holds), `registration` (invitations, registrations, waitlist, form definitions, answers) and a minimal `admission` (admission tokens). Module boundaries per ADR 0001.

### Registration settings on the event

- `accessPolicy`: `open` or `invite_only`; occurrence override `accessPolicyOverride`.
- `listed`: whether the event appears in public listings. Defaults to false for invite-only events, so closed events are not shown in "what's on" calendars.
- `registrationOpensAt`, `registrationClosesAt` (relative to each occurrence's start, e.g. "closes 2 hours before").
- `guestAllowed`: whether "I will bring a guest" is offered. An invitation can override it per guest.
- `waitlistEnabled`, `claimWindow` (default 24 hours, shortened automatically to half the time left when the event is close), `waitlistCutoff` (default 2 hours before start).
- `formFields`: see below.

### Capacity and holds

- One `inventory.capacity_pool` per occurrence with `capacity`, `overbookingPct`, `held`, `taken`.
- `capacity` and `overbooking` are new **rule effect types**, so "evening slots have 30 places" and "weekdays overbook 20 %" work like location and tags. Effective values are materialized by the resolver.
- The bookable limit is `floor(capacity × (1 + overbookingPct / 100))`. The admin always shows capacity and bookable limit side by side.
- Registering takes capacity with the conditional update from ADR 0003. Party size counts: a registration with a guest takes 2.
- A waitlist offer is a **hold** with the claim deadline as expiry. The sweeper releases it and the place goes to the next in line.
- Lowering capacity below what is taken is allowed but flagged; nobody is removed automatically.

### Guest invitation

- Belongs to an **event**. When the event has several occurrences, the guest picks one; one registration per invitation.
- `email` (unique per event), `name`, `locale`, `guestAllowed` (null = event default), `externalContactId` (optional, from the import).
- `status`: `pending` (imported, not sent), `sent`, `accepted`, `declined`. Accepted means a registration exists.
- `token`: a signed, single-purpose token in the personal link (ADR 0005). Rotating it invalidates old links.
- Send log: when sent, by whom, delivery status from Postmark.

### Registration

- Belongs to an **occurrence**; links to an invitation if there is one.
- `name`, `email`, `locale`, `partySize` (1 or 2), `status`: `confirmed`, `waitlisted`, `offered`, `cancelled`.
- `source`: `invitation`, `open`, `staff` (added by hand in the admin).
- One active registration per email per occurrence.
- `waitlistPosition` while waitlisted. Promotion takes the first in line whose party fits; if they don't claim in time, the next.
- A cancelled registration releases its capacity and triggers promotion.

### Form fields

Chosen per event by the event manager. Name and email are always collected.

| Field type | Notes |
|---|---|
| `guest` | "I will bring a guest". Sets party size to 2. Only one per event; shown only where the guest is allowed |
| `dietary` | Choice list (vegetarian, vegan, gluten-free, lactose-free, nut allergy…) plus free text. Always **sensitive** |
| `text` | Short or long free text; can be marked sensitive |
| `checkbox` | E.g. "I agree to be photographed" |
| `choice` | Single or multiple choice from options the manager defines |

- Each field has a localized label and help text, a required flag and an order.
- Field definitions are versioned: changing the form after registrations exist keeps old answers readable.
- **Sensitive answers** (dietary needs, free text marked sensitive) go in a separate table, encrypted per tenant, as in ADR 0003. Dietary needs can reveal health or religion, which makes them special-category data: they are collected with an explicit consent line on the form and deleted soon after the event (see Retention).

### Admission

- One admission per registration, created when it is confirmed, with a signed token. The QR code in the confirmation email encodes it.
- Party size is on the admission, so a validator can later admit "2 of 2".
- No scanning in this phase; the scan log arrives with the validator app.

### Retention

- Account setting **"anonymise registrations after N months"**, default **12**, counted from the occurrence. Names, emails and answers are removed; counts are kept in a stats table.
- **Sensitive answers** are deleted **30 days** after the occurrence by default (account setting, max 12 months).
- Invitations that never led to a registration are deleted with the event's last occurrence plus the same period.

### Outbox events

`invitation.sent`, `invitation.declined`, `registration.confirmed`, `registration.changed`, `registration.cancelled`, `registration.waitlisted`, `registration.offered`, `capacity.changed`. Payloads carry ids and status, never sensitive answers. Consumed internally now (emails, promotion, cache purge); MA connectors subscribe later.

## Flows

### Closed event

1. The event manager creates the event with access policy *invite-only*, sets capacity, picks form fields.
2. Imports the guest list (see below).
3. Sends invitations from the admin, or exports the personal links to send from their MA tool.
4. The guest opens the link, picks an occurrence if there are several, fills in the form and accepts, or declines.
5. Confirmation email with QR code and a link to change or cancel.
6. Reminders: optional reminder to guests who haven't answered, and a reminder before the event to confirmed guests.
7. If the event is full, a guest who accepts joins the waitlist when it is enabled.

### Open event

1. The event has access policy *open*; the public API shows its availability.
2. The client's website links to the hosted registration page for the occurrence.
3. The attendee registers, or joins the waitlist if it is full. Confirmation email as above.
4. When a place frees up, the first person in line gets an email with a link to claim it before the deadline.

### Guest list import

- CSV or XLSX (`exceljs`, MIT). Typical source: an export from the client's CRM or MA tool.
- **Column mapping** step: email (required), name, locale, guest allowed, external contact ID. The mapping is remembered per account.
- **Preview** with row-level errors (invalid email, duplicates in the file) before anything is saved.
- **Re-import** matches on email: new rows are added, existing ones updated, nothing duplicated. Guests missing from the new file are listed and can be removed in one action; removal never happens silently.

### Changes to occurrences with registrations

- An occurrence with registrations is marked `detached` (as planned in mvp.md), so series regeneration never moves or deletes it; it is reported as a conflict instead.
- **Moved** (time or location changed): attendees get an email with the new details and a cancel link.
- **Cancelled**: attendees get an email. Staff can move registrations to another occurrence of the same event in bulk, within its capacity; moved attendees get a new confirmation.

## Admin interface

- **Event → Registration** tab: access policy, listed, open and close times, capacity and overbooking (default, with rules shown as for other effects), guest allowed, waitlist settings, form builder with preview.
- **Event → Guest list** tab: import, list with status filters, send / resend / remind, rotate a guest's link, export links (CSV), counts (invited, accepted, declined, no answer).
- **Occurrence → Registrations**: list with status, party size and answers; add by hand, cancel, move; waitlist with positions; **door list** export (CSV, printable PDF: name, party size, invited or open).
- **Account settings**: retention periods, sender name and reply-to, the account's email template (logo and colours, per ADR 0010).
- **Access to guest data**: who can see names, emails and sensitive answers is a permission, not something every editor gets (see open questions).

## Attendee pages

A small hosted app (new deployment unit, same codebase) on an attendee API with token auth (ADR 0005), localized in the account's locales:

- `/r/{occurrence}`: open registration.
- `/i/{token}`: invitation; accept (with occurrence choice and form) or decline.
- `/m/{token}`: manage a registration; change answers, add or remove the guest, cancel.
- `/w/{token}`: claim a waitlist offer.

The pages use the account's logo and colours; no other branding. Bot protection on the open registration page.

## Public API

Additions to `/public/v1`, within the existing stable shape:

- `admission`: `{ "mode": "registration", "url": "…" }` for open events, linking to the hosted page.
- `availability`: `{ "status": "available" | "few_left" | "full" | "waitlist" | "closed" }`. No exact numbers by default. Short `s-maxage`, purged on `capacity.changed`.
- Unlisted events are left out of `/occurrences` and `/events` listings, but `/events/{idOrSlug}` returns them, so a client can still build a page for a closed event.

## Email

Sent through Postmark (ADR 0010), localized per attendee locale, one template per account:

Invitation · invitation reminder · registration confirmation (with QR code) · waitlist joined · waitlist offer · change confirmation · cancellation confirmation · occurrence moved · occurrence cancelled · reminder before the event.

## Milestones

1. **Capacity:** `inventory` module, pools and holds, `capacity` and `overbooking` effect types, registration settings on events.
2. **Registration core:** registrations, admissions, attendee API and hosted pages for open events, confirmation, change and cancel emails, public availability.
3. **Invitations:** invite-only policy, `listed`, guest list import, sending and reminders, personal links, link export.
4. **Forms and privacy:** form builder, sensitive answers encrypted, retention jobs, door list, guest-data permission.
5. **Waitlist:** positions, promotion with claim holds, offer emails, cutoff.
6. **Pilot:** one closed event and one open, limited event run end to end by a client instead of with free tickets.

### Status

*Milestone 1 (capacity)* is merged. *Milestone 2 (registration core)* is built and tested locally (17 November 2026): `packages/domain/test/acceptance/registration.test.ts` covers the open talk with overbooking, the last place under concurrency, the window, changes, cancelling and public availability; `apps/attendee/test` the pages and the attendee API; `apps/worker/test/registration-email.test.ts` the emails. Decisions taken while building:

- **Confirmed at once** (open question 3): no email verification step. One active registration per email per occurrence; a second attempt gets `already_registered` and is pointed to the confirmation email, so it never reveals or resends the existing link.
- **Attendee links** are 72-character tokens: tenant, purpose (`manage` or `admission`), subject and token version, signed with HMAC-SHA256 under a **per-tenant key in the database** (`registration.token_key`, created on first use). The tenant is readable before verification, so the request opens that tenant's transaction and checks the signature there; no secret outside the tenant's own data, nothing to configure per environment. The QR code holds the admission token, which cannot be used as a manage link. Bumping `token_version` invalidates both.
- **Open registration finds its tenant** from the occurrence id through `registration.occurrence_tenant`, a `SECURITY DEFINER` function that only answers for published or cancelled registration events.
- **The attendee app** (`apps/attendee`, its own container app) renders the pages on the server, without client JavaScript, and serves `/attendee/v1` beside them; both call the same service layer. Basic bot protection: a honeypot field, a minimum time on the form and a per-IP rate limit; a CAPTCHA service can be added if spam appears. Manage tokens are kept out of logs and referrers.
- **Changes** (name, guest) are possible until registration closes; **cancelling** until the occurrence starts. Staff may add people outside the window and with a guest the event does not offer, but never beyond the places.
- **An occurrence with registrations** is detached when the first one arrives (without a version bump, so it stays visible in the public API) and cannot be deleted (409; cancel it instead).
- **Public availability**: `few_left` from a tenth of the bookable limit (at least one place). Invite-only occurrences show `admission.url: null`. The status is cached for the usual 30 s; no purge on `capacity.changed` yet. `waitlist` arrives with milestone 5.
- **Emails** go out from the worker, one job per outbox event, and show the registration as it is when the job runs (no confirmation for a registration cancelled in the meantime). A change of locale alone sends nothing. The QR code is an inline PNG. The account's own template waits for the account email settings.
- **Permissions**: `registrations.read` and `registrations.write`, held by owner, editor, event manager and box office (door staff read only), so the guest-data permission (open question 1) can be narrowed in milestone 4 without touching content permissions.
- **Moved and cancelled occurrences**: confirmed attendees get an email with the new details, the QR code and a cancel link when the time changes (an edit or "reset to series") or the place changes, whatever caused it (override, rule or event default; the resolver emits `occurrence.relocated.v1`). They get a cancellation email when the occurrence or the whole event is cancelled; their registrations stay as they are. One job per registration with a one-minute delay, so several changes in a row send one email with the final details. Other changes (places, tags, link) send nothing.
- **Not in this milestone**: moving registrations to another occurrence in bulk.

*Milestone 3 (invitations)* is built and tested locally (17 November 2026): `packages/domain/test/acceptance/invitations.test.ts` covers the gala import from XLSX and the re-import, row errors, accepting with a guest, declining and changing one's mind, links, sending and delivery reports, unlisted events and the reminder; `apps/attendee/test/invitation.test.ts` the invitation page and API; `apps/worker/test/invitations.test.ts` the emails and the reminder; `apps/api/test/invitations.test.ts` the guest list API and the Postmark webhook. Decisions taken while building:

- **Invitation links** use the same token format with a third purpose, `invitation`, signed with the tenant's key; the subject is the invitation and `token_version` lives on it, so rotating a guest's link leaves their registration's links alone. `/i/{token}` lets the guest pick a time (only bookable ones can be chosen), enter their name if the list has none, add a guest if the invitation allows it, and accept or decline. Once accepted, the link redirects to the registration's manage page.
- **The invitation is the guest's ticket to any of the event's occurrences**, whatever the occurrence's access policy. The registration window and the places apply as for open registration. The invitation's guest allowance overrides the event's, also when the guest changes the registration later.
- **Declining** can be undone: the link keeps working, and the guest can accept while registration is open (open question 4: yes). A guest who cancels an accepted registration is counted as declined.
- **Import**: the file is read on the server (`exceljs` for XLSX; CSV with the delimiter sniffed from the header, UTF-8 or Windows-1252) and staged for a day as `registration.guest_import`, so preview and import read the same rows. The mapping suggests columns from the account's last mapping (stored by header text) and from common header names in Norwegian and English. A name can come from one column or from first and last name. Mapped columns overwrite on re-import, and an empty cell clears the value. Rows with errors are skipped and listed. Guests missing from the file are listed. Ticked ones are removed in the same step, but guests who have accepted are never removed: they are shown as blocked.
- **Sending**: staff ask for invitations (to guests not sent one, or named guests as a resend) or reminders (to guests sent one who haven't answered). Each email is a logged `registration.invitation_send` with one worker job. The job skips guests who answered in the meantime, and events that are no longer published, and marks the send `failed` with the reason. Sending needs a published event; importing and exporting links don't. `invitation.sent.v1` is emitted when the email has gone out.
- **Delivery status**: emails carry Postmark `Metadata` (`tenantId`, `sendId`), and the API's `/webhooks/postmark` (basic auth, `POSTMARK_WEBHOOK_AUTH=user:password`) records `delivered`, `bounced` and `spam_complaint` on the send whose id and `MessageID` both match. Soft bounces and auto-replies are ignored, and a delivery never overwrites a bounce. The guest list shows the latest send and flags undeliverable addresses.
- **Link export** is a UTF-8 CSV with a BOM, semicolon-separated by default so Excel in Norway opens it (`?delimiter=comma` for MA tools). Cells that start with `=`, `+`, `-` or `@` are prefixed so spreadsheets don't run them. Guests sent from the client's own tool can be marked as sent, logged as an `external` send.
- **Unlisted events** are left out of `/events` and `/occurrences` in the public API. Asking for one event by id or slug (`/events/{idOrSlug}`, `/occurrences?event=`) still finds it.
- **Reminder before the event** (`reminderMinBefore`, off by default): one job per confirmed registration, keyed by it and scheduled for the reminder time. It is queued again when the registration is confirmed, the occurrence's time changes, the event is published or the setting changes. A job that runs early reschedules itself. The email has the QR code and a cancel link. Nobody who registered after the reminder time gets one, and each registration gets at most one.

## Acceptance scenarios

- A gala with 120 places: 150 guests imported from an XLSX export, 30 of them allowed a guest. Re-importing the file with 10 new rows adds exactly 10 invitations.
- A guest accepts with a guest and a dietary need; the occurrence shows 2 places taken, and the door list shows the party size. 30 days after the event, the dietary answer is gone; 12 months after, the registration is anonymised and the count remains.
- An open talk with 40 places and 10 % overbooking takes 44 registrations, then puts people on the waitlist. A cancellation offers the place to the first in line whose party fits; if they don't claim it within the window, it goes to the next.
- Two people register for the last place at the same moment; exactly one gets it (conditional update per ADR 0003).
- An invite-only event doesn't appear in the public "what's on" listing, but its page can be fetched by slug.
- Changing a series' start time leaves occurrences with registrations in place and flags them, and nobody is moved without staff action.
- An occurrence with registrations is cancelled; every attendee gets an email, and staff move them to another occurrence in one action.
- A second tenant cannot see any registration, invitation or answer from the first, verified by tests on every new table.

## Open questions

1. **Guest-data permission:** enable the *event manager* role from ADR 0005 now, with access to guest data, and keep *editor* to content only? Or a separate "can see guest data" flag?
2. **Open registration on client websites:** is a link to our hosted page enough at first, or do clients expect the form embedded on their site?
3. **Email verification for open registration:** confirm at once (like free tickets today) or require clicking a link first, to stop fake or mistyped sign-ups?
4. **Declined guests on the waitlist:** can a guest who declined change their mind through the same link until registration closes? (Proposed: yes.)
5. **Default dietary options:** which list, and does it need to vary per account?
6. **Availability detail:** should clients be able to show exact places left ("12 places left") as an account setting?
