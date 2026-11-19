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
