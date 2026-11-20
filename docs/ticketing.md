# Ticketing – offers, prices and reservations

*Draft, 19 November 2026. Builds on [docs/registration.md](registration.md) and [docs/mvp.md](mvp.md). Epics #12 (offers and pricing), #13 (commerce integration contract), #14 (POS). Decisions: [docs/adr](adr/README.md).*

## Goal

Let clients sell paid tickets through **the sales channels they already have** (their web shop and their POS), with the platform as the single owner of everything time-bound: what is for sale, at what price, how many are left, and who holds a valid ticket.

- Staff set up **offers** (ticket types such as Adult, Student, Child) per event, with **prices** that vary by occurrence through defaults, rules and overrides.
- Each account maps its offers to the **SKUs** its web shop and ERP know, so the shop sells a thin product shell and takes price, line name and stock from the platform.
- The channel **reserves** tickets while the buyer pays, **confirms** them once it has charged the buyer, and **cancels** them if the buyer gives up or is refunded. Confirming issues admissions with QR codes, exactly as registrations do.

The platform takes **no payments** in this edition. Cart, checkout, payment, receipts and refunds of money stay in the client's channel. Hosted checkout is epic #17 (phase 3).

## Scope

### In

- **Offers** per event: localized name, VAT class, channels, sales window, places per unit, limits per reservation.
- **Prices** per offer and occurrence: offer default → `price` rule effect targeted at the offer → override per (offer, occurrence). Resolved and materialized like capacity, with source and rule id.
- **VAT classes** and **sales channels** per account, and the **SKU mapping** (VAT class + channel → external SKU).
- **Channel credentials**: a secret, server-side API key per sales channel, so reservations know which channel made them.
- **Reservations API**: reserve, read, extend, confirm and cancel, all idempotent; a signed line snapshot per line.
- **Tickets and admissions**: one ticket per unit sold, each with an admission and a signed admission token for the QR code.
- **Public API**: offers, prices and per-occurrence availability for browsing, cached like the rest of `/public`.
- **Admin**: offers editor, price grid (offers × occurrences, with source), account settings for VAT classes, channels and SKUs, and a sales view per occurrence.
- **Outbox events** for offers, prices, reservations and tickets.

### Out, and how this prepares for it

| Out of scope | Prepared by |
|---|---|
| Checkout and payment (epic #17) | Reservations are the basket: a hosted checkout becomes one more channel that reserves and confirms |
| Refunds of money | Cancel takes the channel's refund reference; the money moves in the channel |
| Discount codes, bundles, memberships | Prices are resolved per (offer, occurrence) and frozen in the snapshot; a discount is a later adjustment on the line |
| Seat maps, reserved seating | Lines draw from pools; a seat is a pool of one |
| Quotas per offer ("max 20 student tickets") | ADR 0003's multi-pool holds; offers already name the pool they draw from |
| Ticket delivery from the platform (epic #11) | Confirm returns ticket URLs and QR payloads; the channel shows or sends them |
| Validator and scanning (epic #7, #8) | Admissions per ticket from day one |
| Per-price-point SKUs for shops that cannot override line prices | SKU mapping is a table, so a finer key can be added |
| Reconciliation report | Every confirmed line stores price, VAT rate, SKU and the external order reference |

## Data model

New module schema `offers` (offers, prices, VAT classes, channels, SKU mapping) and `sales` (reservations, lines, tickets). `inventory` and `admission` are extended. Module boundaries per ADR 0001.

### Event settings

- `admissionMode` gains `tickets`, beside `none`, `external` and `registration`. A ticketed event's occurrences get a capacity pool, as registration events do; `capacity` and `overbooking` effects work unchanged.
- Registration and tickets do not mix on one event in this edition. A free ticket is an offer priced 0.
- Ticketed events have **no waitlist** in this edition.

### VAT class (account)

- `code` (e.g. `exempt`, `low`, `reduced`, `standard`), `label`, `ratePct`. Clients set these with their accountant; the platform makes no claim about which admissions are exempt.
- A rate in use cannot be changed; a new class is added and offers are moved to it, so sold lines keep the rate they were sold with.

### Sales channel (account)

- `code` (`web`, `pos`, …), `name`, `kind` (`ecom`, `pos`), `holdMinutes` (default 15; extend can bring a reservation to at most 60 in total), `active`.
- `sendTickets` (default off): the platform emails the tickets on confirm when a buyer email is given. Otherwise the channel delivers them from the confirm response.
- One or more **channel keys** (`sk_<id>_<secret>`, a new API key kind, server-side only), held by the channel's connector. A channel key can only call the reservations API and read offers, prices and availability.

### SKU mapping (account)

- `(vatClass, channel) → externalSku`, e.g. `exempt + web → TICKET-VAT0`. Unique per pair.
- An offer cannot be offered in a channel where its VAT class has no SKU; the admin shows the gap.

### Offer (event)

- Offers belong to the event. The editor can **copy offers from another event** (names, VAT class, channels, window, limits and default prices); account-level templates are not planned for this edition.
- `name` and `description` per locale, `code` (stable, for connectors), `vatClass`, `channels` (which sales channels may sell it), `sortOrder`, `status` (`active`, `archived`).
- `placesPerUnit` (default 1): a family ticket takes 4 places and gives one admission with party size 4.
- `minPerReservation`, `maxPerReservation` (default 1 and 20).
- **Sales window**: `onSaleAt` / `offSaleAt` relative to each occurrence's start, or absolute, like the registration window.
- `defaultPrice`: amount in minor units (øre), **including VAT**, in the account's currency (NOK only for now).

### Prices

- `offers.price_override (offer_id, occurrence_id, amount)`: one offer at one occurrence.
- `price` is a new **targeted rule effect type**: `targetRef` is the offer id, the value `{ amount }`. "Weekend matinees: Adult 250, Child 120" is one rule with two effects.
- `offerAvailable` is a second targeted effect (`false` takes the offer off sale at matching occurrences, e.g. no student price on Saturday evenings), with an override too.
- The resolver materializes **effective prices** per (occurrence, offer) with source (`default`, `rule`, `override`) and rule id, so availability and reservations never evaluate rules (ADR 0003). The rule engine's fields become keyed by (field, targetRef).

### Reservation

- Belongs to a **channel**. `status`: `held`, `confirmed`, `cancelled`, `expired`. `expiresAt` while held.
- `externalRef` (the channel's cart or quote id), set on reserve; `externalOrderRef` set on confirm.
- **Lines**: occurrence, offer, quantity, and a **snapshot** frozen at reserve time: unit price, VAT class and rate, external SKU, line name ("Adult – Hamlet, Sat 14 Feb 19:30, Main stage"), occurrence start in UTC and its timezone, location name.
- Places are held with one `inventory.hold` per pool, referencing the reservation. A reservation may span occurrences; pools are updated in pool id order (ADR 0003).
- Optional **buyer** (name, email, locale), one per reservation, given on confirm, for the ticket page and the tickets email. The shop keeps the full customer record; tickets are not named. Personal data, with the same retention as registrations.

### Ticket and admission

- One `sales.ticket` per unit of a confirmed line, with its own **admission** (party size = the offer's `placesPerUnit`). `admission.admission` gains a `ticket_id` beside `registration_id`; exactly one is set.
- Admission tokens use the existing token format with a new subject; tickets get a ticket URL on the attendee app that shows the QR code.
- `status`: `valid`, `cancelled`. Cancelling voids the admission and releases the places.

### Outbox events

`offer.changed`, `price.changed` (per occurrence, batched), `reservation.held`, `reservation.confirmed`, `reservation.cancelled`, `reservation.expired`, `ticket.cancelled`, and the existing `capacity.changed`. Payloads carry ids, amounts and status, never buyer details.

## Reservations API

On `/v1`, called with a channel key. `Idempotency-Key` is **required** on every write (ADR 0007). Errors are problem details with stable reason codes.

| Endpoint | Does | Reasons |
|---|---|---|
| `POST /v1/reservations` | Holds places for all lines or none, prices them and returns the reservation with snapshots, `expiresAt` and a signature. With `confirm: true` and `externalOrderRef` it also confirms in the same transaction: the one-call sale for POS walk-ups | `sold_out` (with the line and places left), `not_on_sale`, `offer_unavailable`, `channel_not_allowed`, `no_sku`, `quantity_out_of_range` |
| `GET /v1/reservations/{id}` | The reservation as it is now: the source of truth for the connector before charging | |
| `POST /v1/reservations/{id}/extend` | Moves `expiresAt` forward (within the channel's limit) before payment starts; revalidates the lines | `expired`, `extend_limit` |
| `POST /v1/reservations/{id}/confirm` | Takes the held places, issues tickets and admissions, stores `externalOrderRef` and the buyer, returns tickets with QR payloads and URLs | `expired_sold_out`, `already_cancelled` |
| `POST /v1/reservations/{id}/cancel` | Held: releases the places. Confirmed: cancels all tickets, or those listed, voids their admissions and releases their places, with an optional `externalRefundRef` | `already_cancelled`, `occurrence_started` |

- **Signature**: the reservation and each line carry an HMAC under the tenant's token key, so a connector can check a snapshot that came back through the browser. The simplest safe connector ignores the browser and reads `GET /v1/reservations/{id}` server-side.
- **Confirm after expiry**: the buyer may already have paid. Confirm tries to take the places again; if they are gone it fails with `expired_sold_out` and the channel refunds. Expiry is checked on confirm, not only by the sweeper (ADR 0003, #47).
- **Prices are never posted** by the channel. Confirm charges what the snapshot says.
- **Locking** follows the registration code: key share on the occurrence, then pools in id order, then the reservation.

## Public API

- `GET /public/events/{idOrSlug}` and `/public/occurrences` gain `offers`: code, localized name, price (amount, currency, incl. VAT), on sale or not, in display order.
- Availability per occurrence: `available`, `few_left`, `sold_out`, `not_on_sale`, using the same thresholds as registration. Exact places left stays an open question (registration.md, question 6).
- Channel-key callers get exact places left and the offers for their channel.

## Admin interface

- **Event → Offers**: list, editor, sales window, channels. Warnings for missing SKUs.
- **Event → Prices**: the price grid, offers × occurrences, each cell showing the amount and its source (default, rule name, override), with inline override and clear (ADR 0015's TanStack Table).
- **Rules**: `price` and `offerAvailable` effects in the existing rule editor, with the offer as target.
- **Account → Sales**: VAT classes, channels and their keys, SKU mapping.
- **Occurrence → Sales**: held and sold per offer, confirmed reservations with external order refs, cancel tickets.

## Permissions

- `offers.write` (offers, prices, price rules): owner, event manager.
- `sales.read` (reservations, tickets, buyers): owner, event manager, box office, finance.
- `sales.write` (cancel tickets from the admin): owner, event manager, box office.
- `account.write` for VAT classes, channels, keys and SKUs.
- *Box office* and *finance* become enabled roles.

## Changes to occurrences with tickets

- An occurrence with tickets is detached and protected like one with registrations: it cannot be deleted, only cancelled.
- Cancelling or moving an occurrence keeps the tickets as they are and emits the events; refunds are the channel's decision. Webhooks to channels arrive with epic #9.

## Milestones

1. **Offers and prices:** `admissionMode: tickets`, VAT classes, offers, default prices and overrides, `price` and `offerAvailable` effects, targeted fields in the resolver, effective prices, admin offers editor and price grid, public API offers and prices.
2. **Channels and SKUs:** sales channels, channel keys, SKU mapping, channel availability per offer, sales windows, availability for channel callers.
3. **Reservations:** reserve, read, extend, confirm and cancel while held; holds per reservation, expiry and sweeper, snapshots and signatures, tickets and admissions with ticket pages.
4. **After the sale:** cancelling confirmed tickets, occurrences with tickets protected, buyer data and retention, admin sales view, outbox events complete.
5. **Integration guide and pilot:** the integration guide (data ownership per purchase stage), contract tests against the OpenAPI spec, and one client selling through their web shop and POS.

### Status

*Milestone 1 (offers and prices)* is built and tested locally (19 November 2026): `packages/domain/test/acceptance/ticketing.test.ts` covers the first two acceptance scenarios (the Saturday-evening student rule and the weekend price with one override), permissions, copying, VAT classes and the public API; `packages/domain/test/rules.test.ts` the targeted engine; `apps/api/test/offers.test.ts` the endpoints. Decisions taken while building:

- **One override table.** `offers.offer_override (offer_id, occurrence_id, amount, available)` holds both overrides; a null column inherits. Endpoints: `PUT` and `DELETE /v1/offers/{id}/occurrences/{occurrenceId}/override`.
- **Effective prices in their own table.** `offers.effective_price` has one row per (occurrence, offer), with amount and availability and the source and rule of each, rather than adding a target to `rules.effective_value`. Reservations (milestone 3) read a typed amount, and rows go with their offer.
- **The engine resolves targets.** `rules.resolveTargets` resolves `price` and `offerAvailable` per offer: override, then the highest-priority matching rule with an effect on that (field, offer), then the offer's default (its `defaultPrice`, and on sale). Ties are reported per target. The rule preview compares targeted fields too, so a price rule's save resolves the event like any other rule, and `changes[].fields[]` and `conflicts[]` carry `targetRef`.
- **What triggers resolution.** Rule changes, a new offer, a new default price and copying offers resolve the event (inline up to 2,000 occurrences, otherwise by the worker on `offer.changed.v1`). An override resolves its occurrence. New occurrences are priced as they are created. `price.changed.v1` is emitted once per resolution batch with the occurrences whose price or availability changed.
- **Locking.** Offer changes lock the event row for update, like rule changes, so a resolver that started earlier cannot publish prices from an older configuration (#41). Overrides take the event for share and then the occurrence for update, as schedule changes do.
- **Price rules need `offers.write`.** Creating, editing or deleting a rule with a `price` or `offerAvailable` effect takes `offers.write` on top of `content.write`, so editors keep plain rules but not prices. Effects must name an active offer of the same event. An offer that rules refer to cannot be deleted.
- **Offers need `admissionMode: tickets`** to be created or copied. Ticketed events get a capacity pool per occurrence from `registration.capacity` and `overbookingPct`; the other registration settings do not apply.
- **VAT.** A class an offer uses keeps its rate (409); its label can change, and it can be archived so no new offer uses it. Rates have at most two decimals.
- **Public API.** Each occurrence has `offers`: the active offers available there, in display order, with `price { amount, currency: "NOK", vatIncluded }` and `onSale` (false once the occurrence is cancelled or has started; sales windows arrive with milestone 2). Offers taken off sale at an occurrence are left out. `admission` is `{ mode: "tickets" }`. Availability for ticketed occurrences (`available`, `few_left`, `sold_out`, `not_on_sale`) is not built yet: it needs holds and sales, so it moves to milestone 3, and `availability` stays null until then.
- **Admin.** Event → Ticket types (editor, copy from event), Event → Prices (grid with source per cell, override and clear in a popover), price and sale effects per offer in the rule editor, VAT classes under Settings. Ticketed occurrences show places and take capacity overrides like registration occurrences.

*Milestone 2 (channels and SKUs)* is built and tested locally (19 November 2026): `packages/domain/test/acceptance/channels.test.ts` covers channels, keys, the SKU mapping, channels per offer, sales windows and what channel callers see; `apps/api/test/channels.test.ts` the endpoints; `apps/public-api/test/public.test.ts` channel keys on the public API. Decisions taken while building:

- **Tables.** `offers.sales_channel`, `offers.sku_mapping (vat_class_id, channel_id) → external_sku` and `offers.offer_channel`. Channel keys are rows in `tenancy.api_key` with the new kind `channel` and a `channel_id`. Endpoints: `/v1/sales-channels` (list, create, `PATCH` with If-Match), `/v1/sales-channels/{id}/keys` (list, create, revoke) and `PUT`/`DELETE /v1/sku-mappings/{vatClassId}/{channelId}`. Changing any of them takes `account.write`; members can read channels and SKUs, like VAT classes. Channel keys are listed and created under their channel, not under `/v1/api-keys`.
- **Channels per offer.** An offer lists the channels that may sell it (`channelIds`). A new offer gets every active channel unless it names them; copying keeps the source's active channels. Offers report `channelsWithoutSku`: channels where their VAT class has no SKU. Saving such an offer is allowed, so the SKUs can be added afterwards; the admin shows the gap on the offer and in the list, and channel callers see the offer with `sku: null` and `onSale: false`.
- **Sales windows.** Each bound is relative (`onSaleMinBefore`, `offSaleMinBefore`) or absolute (`onSaleAt`, `offSaleAt`), not both; setting one form clears the other. No opening: on sale once the event is published. No closing: until the start. Sales never run past the start, so an absolute close after it closes at the start. Windows are read from the offer at request time, not materialized, so a change needs no resolution. Public offers carry `opensAt` and `closesAt`, and `onSale` respects the window.
- **Channel keys on the public API.** `Authorization: Bearer sk_…` reads `/public/v1` like a preview token (server-side, never cached) but sees published events only, and only the offers its channel sells, each with `sku`, `placesPerUnit`, `minPerReservation` and `maxPerReservation`. Ticketed occurrences get `availability` with `status` (`available`, `few_left`, `sold_out`, `not_on_sale`), `placesLeft` and the earliest opening and latest closing of the offers' windows; sold out means no on-sale offer's smallest purchase (places per unit × minimum per reservation) fits in the places left, so a family ticket stops selling when 3 places remain. The channel must be active on every request, so deactivating it stops its keys at once despite the key cache. Anonymous callers still get `availability: null` for ticketed occurrences until milestone 3.
- **Outbox.** `sales_channel.changed.v1` and `sku_mapping.changed.v1`; offer channel and window changes emit `offer.changed.v1` with `resolution: "none"`.
- **Not yet.** Channel keys calling `/v1` (the reservations API) arrive with milestone 3, which also uses `holdMinutes`. `sendTickets` is stored but does nothing until tickets exist.

*Milestone 3 (reservations)* is built and tested locally (20 November 2026): `packages/domain/test/acceptance/reservations.test.ts` covers the reservation acceptance scenarios (the web shop's 2 Adult + 1 Child confirmed into three tickets, a price change after reserve, two channels racing for the last place, expiry during payment both ways, the family ticket) and the reasons; `apps/api/test/reservations.test.ts` the endpoints, idempotent retries and tenant isolation; `apps/attendee/test/tickets.test.ts` the ticket page; `apps/worker/test/reservations.test.ts` the sweeper. Decisions taken while building:

- **Tables.** `sales.reservation`, `sales.reservation_line` (the snapshot, never changed after reserve), `sales.reservation_hold` (one inventory hold per occurrence, with its places, kept after the hold ends so confirm can take the places again) and `sales.ticket`. `admission.admission` gains `ticket_id`; exactly one of `registration_id` and `ticket_id` is set.
- **Channel keys on `/v1`.** Only `/v1/reservations` accepts them (`Authorization: Bearer sk_…`); staff tokens get 401 there, and channel keys get 401 everywhere else. Whether the channel is active is checked inside every request. A channel sees only its own reservations; another channel's or tenant's id is 404.
- **Lines.** One line per (occurrence, offer), with a quantity; a reservation has 1–50 lines and may span occurrences. Unknown occurrences and offers are 404 with the line index. Every reason carries `details.line`; `sold_out` carries the occurrence, `placesLeft` and the places asked for. The line name is "{offer} – {event}, {short date and time in the event's timezone}, {location}" in the reservation's locale (the `locale` given, else the account default).
- **Signatures under the channel key, not the tenant key.** A connector cannot check an HMAC under a key it does not hold, so each response is signed for the key that asked: HMAC-SHA256 under the SHA-256 of the key's secret, which the connector has and the platform stores only as that hash. The signed text is a fixed JSON array per line and per reservation (`sales.lineSignatureText`, `reservationSignatureText`); the integration guide (milestone 5) will document it. Reading server-side with `GET` stays the simplest safe connector.
- **Idempotency.** `Idempotency-Key` is required on every write (428 `idempotency_key_required` without it) and scoped per channel. Responses carry buyer details, so the store keeps only the reservation id and a retry returns the reservation as it is now: the same tickets for a retried confirm. Confirming again without the key for the same `externalOrderRef` returns the confirmed reservation; another order is `already_confirmed`.
- **Expiry.** A held reservation past `expiresAt` reads as `expired` at once. The sweeper (`sales:sweep_reservations`, every minute in the worker's crontab) releases the places and emits `reservation.expired.v1`, one reservation per transaction so it never holds two reservations' pool locks out of order. Confirm after expiry, before or after the sweep, takes the places again if they fit, else `expired_sold_out` and nothing changes. Extend moves the reservation and its holds to `minutes` from now (default the channel's hold time), at most 60 minutes after reserve; it revalidates offer, channel, SKU, availability and sales window, but not the price.
- **Confirm** does not recheck the sales window or start: the buyer has paid for a valid hold. Tickets get one admission each with party size = places per unit. Reserving detaches a series occurrence, like registering does, so regeneration keeps it on the frozen time (reserve locks the occurrences before it reads what to freeze, and the occurrence stays detached after the reservation ends: reattach keeps any occurrence a reservation line points at detached, so regeneration never tries to delete it). If staff move a held occurrence by hand, confirm fails with `schedule_changed` and nothing changes: the channel refunds and reserves again. Outbox: `reservation.held.v1`, `reservation.confirmed.v1` (with `afterExpiry`), `reservation.cancelled.v1`, `reservation.expired.v1`; ids, amounts and status only.
- **Ticket links.** The QR payload is an admission token (the existing format, subject the admission). The ticket page `/t/{token}` uses a new `ticket` token purpose; both carry the ticket's token version so cancelling (milestone 4) can invalidate them. Confirm returns `url` and `qr` per ticket.
- **Public availability.** Anonymous callers now get `availability` for ticketed occurrences (`status`, `opensAt`, `closesAt`, no `placesLeft`); held places count as gone, so a shop's open carts can show an occurrence as sold out until they expire.
- **Not yet.** Cancelling confirmed tickets (cancel answers 409 `conflict`), the buyer's retention, the tickets email for `sendTickets` channels, and staff views of reservations arrive with milestone 4. Staging runs the worker as a sidecar, so the sweeper runs while the API is up; confirm and reads do not depend on it.

*Milestone 4 (after the sale)* is built and tested locally (20 November 2026): `packages/domain/test/acceptance/after-sale.test.ts` covers the refund scenario (part, then the rest), the family ticket, `occurrence_started`, staff cancelling and the sales view with permissions, tenant isolation, protected occurrences, the tickets email's conditions and buyer retention; `apps/api/test/sales.test.ts` the endpoints and roles; `apps/worker/test/tickets-email.test.ts` the email and the nightly run. Decisions taken while building:

- **Cancel.** `POST /v1/reservations/{id}/cancel` takes an optional body `{ ticketIds?, externalRefundRef? }`. Held or expired: releases the places as before (ticket ids and refunds are refused). Confirmed: cancels the listed tickets, or all valid ones, bumps their token version (the ticket page and QR code stop working), voids their admissions and releases their places per occurrence in pool order. The reservation stays `confirmed` while any ticket is valid and becomes `cancelled` with the last one. Listing a cancelled ticket is `already_cancelled` with `details.ticketIds`; a ticket that is not the reservation's is `validation_failed`. `occurrence_started` once an occurrence has begun, unless it was cancelled: refunding a cancelled show always works. The same rule applies to staff.
- **Tables.** `sales.ticket` gains `cancelled_by` (`channel`, `staff`) and `external_refund_ref`; `sales.reservation` gains `anonymised_at`. No new tables. Tickets carry `cancelledAt`, `cancelledBy` and `externalRefundRef`; reservations carry `anonymisedAt`.
- **Staff.** `GET /v1/occurrences/{id}/sales` (held, sold, cancelled, places and revenue per offer; reservations with lines there, newest first, at most 2,000, with buyers and tickets at that occurrence), `GET /v1/sales/reservations/{id}` and `POST /v1/sales/reservations/{id}/cancel` (confirmed only; `conflict` for held ones, which the channel releases). Staff cancels are audited as `tickets.cancelled` on each event involved. The channel is not told until webhooks (epic #9); it sees the cancellation on its next `GET`.
- **Permissions.** `sales.read`: owner, event manager, box office, finance. `sales.write`: owner, event manager, box office. Box office and finance can now be invited. The admin does not yet hide content-editing controls from these read-only-content roles; the API refuses them.
- **Protection.** Occurrences with any reservation line were already undeletable (foreign key) and kept detached since milestone 3; the error and the admin message now say "registrations or tickets". Cancelling or moving an occurrence leaves tickets as they are.
- **Tickets email.** On `reservation.confirmed.v1`, channels with `sendTickets` and a buyer email get one email with each valid ticket's line name, time, place, ticket page link and, for the first ten, an inline QR code, in the buyer's locale (else the reservation's). Line names stay in the locale they were frozen in.
- **Retention.** The nightly retention job anonymises reservations `anonymiseAfterMonths` after the last occurrence they have lines at ends: buyer name, email and locale go, ticket links and QR codes stop working, admissions are voided. Lines, prices, SKUs, order and refund references and ticket statuses stay for reconciliation.
- **Outbox.** `ticket.cancelled.v1` per cancel (ticket ids, occurrences, amount, order and refund references, `by`, `remainingTickets`), and `reservation.cancelled.v1` (with `by`) when the last ticket goes. No buyer details.

## Acceptance scenarios

- A concert with Adult 450 and Student 250, Student off sale on Saturday evenings by a rule: the price grid shows each cell's source, and the public API shows only Adult on Saturdays.
- A weekend rule sets Adult to 500; one occurrence is overridden to 400. Changing the rule moves every weekend price except the override, and a reservation made before the change keeps its old price through confirm.
- The web shop reserves 2 Adult + 1 Child, gets three snapshot lines with `TICKET-VAT0`, confirms with its order number and gets three tickets with QR codes. A retry of the confirm with the same key returns the same tickets.
- Two channels reserve the last place at the same moment; exactly one succeeds, the other gets `sold_out`.
- A reservation expires during payment; confirm succeeds if the places are still free and fails with `expired_sold_out` if not.
- A confirmed order is refunded in the shop; cancel with the refund reference voids the admissions and the places go back on sale.
- A family ticket takes 4 places and gives one admission with party size 4.
- A second tenant's channel key cannot read or confirm the first tenant's reservations, verified by tests on every new table.

## Decisions

*Settled 19 November 2026, before building.*

1. **Ticket delivery:** the channel delivers. Confirm returns ticket URLs and QR payloads for the shop's own receipt; the platform also emails the tickets when the channel's `sendTickets` is on and a buyer email is given.
2. **Buyer data:** one optional buyer per reservation (name, email, locale). No named tickets in this edition.
3. **Offers:** per event, with copying from another event. No account templates.
4. **Hold time:** 15 minutes by default per channel, extendable to 60 in total with `extend`.
5. **Free events:** registration and tickets both stay, and do not mix on one event. Registration is for free events with invitations, forms or a waitlist; a 0-priced offer is for free tickets sold through the shop.
6. **POS quick sale:** reserve takes `confirm: true` for a one-call sale.
7. **Endpoints:** beside reserve, confirm and cancel, `GET` (the connector's source of truth before charging) and `extend` are in.
8. **Off-sale rule:** the `offerAvailable` effect and its override are in.
