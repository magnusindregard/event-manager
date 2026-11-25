# Hosted checkout – Vipps MobilePay

*Draft, 25 November 2026. Epic #17. Builds on [docs/ticketing.md](ticketing.md). Decision: [ADR 0018](adr/0018-hosted-checkout-and-payments.md).*

## Goal

Let clients without a web shop sell tickets. The platform hosts a checkout page per occurrence. The buyer pays with Vipps MobilePay, and the money goes straight to **the client's own Vipps merchant account**. The platform starts the payment on the client's behalf and never holds money.

The checkout is a sales channel of kind `hosted`. It reserves, confirms and cancels through the same functions as a shop's connector. Prices, VAT, holds, limits, the snapshot and the tickets all work as in [ticketing.md](ticketing.md).

## Connecting Vipps MobilePay

**Settings → Payments** (owners):

- **Connect.** Choose test (the Vipps MT environment) or production. Enter the merchant serial number (MSN), client id, client secret and subscription key from the Vipps portal.
  - The keys are checked first, by fetching an access token. Vipps refusing them refuses the connection.
  - The keys are stored encrypted with the account's data key, bound to the provider account. They are never shown again.
  - Connecting another merchant replaces the old one. Its keys are deleted, and its webhook is removed at Vipps.
- **Webhook.** On connect and on verify, the platform registers a webhook at Vipps for the ePayment events, at `POST /webhooks/vipps/:accountId/:providerAccountId` on the core API. Its signing secret is stored encrypted.
  - Without a public URL (`PUBLIC_URL` unset, as on local stacks), no webhook is registered. Payments are then found by polling.
- **Status.** `active`; `invalid` when Vipps refused the keys at the last check (enter new ones); `disconnected`.
- **Verify** checks the stored keys again and registers a missing webhook.
- **Disconnect** deletes the keys and the webhook. Payments already made stay.
- **Merchant details** (on the account): legal name, organisation number (mod-11 checked), address, and whether the account is VAT-registered. They are printed on receipts.

Everyone in the account can see the connection. Only owners change it (`account.write`).

## The buy flow

1. The buyer opens `/b/:occurrenceId` on the attendee app. It shows the occurrence's offers on the hosted channel, at their public prices, with a quantity per offer.
2. The buyer gives quantities, a name, an email and optionally a phone number. The form has the attendee app's honeypot, minimum time and rate limit.
3. `startCheckout`:
   1. Reserves on the hosted channel.
   2. Extends the hold, so that it outlives the Vipps payment's expiry.
   3. Creates a Vipps payment for exactly the reservation's total, with a new reference.
   4. Sends the buyer to the Vipps landing page (303).
4. The buyer approves or rejects in the Vipps app. Vipps sends the buyer back to `/b/return/:reference?sig=…` (signed with the `checkout` token purpose), and sends a webhook.
5. `processPayment(reference)` runs from the return page, the webhook job and the reconcile job. It is idempotent and reads Vipps as the source of truth:

| Vipps says | Platform does | Payment state |
|---|---|---|
| CREATED | nothing yet (the return page waits and refreshes) | `created` |
| AUTHORIZED | `confirm(externalOrderRef = reference)`, then capture the total | `authorized` → `captured` |
| AUTHORIZED, but confirm fails (sold out after the hold expired, or the occurrence changed) | cancel the authorisation; no tickets | `cancelled` |
| ABORTED (the buyer said no) | cancel the reservation, releasing the places | `failed` |
| EXPIRED | cancel the reservation | `expired` |
| TERMINATED | cancel the reservation if it is still held | `cancelled` |

6. On capture, the buyer gets the tickets email (the hosted channel sends tickets) and a receipt. The receipt is also attached to the payment in the Vipps app (Order Management API).

**Expiry.** If the reservation sweeper expires a hold whose payment is still `created`, the payment is cancelled at Vipps. If a payment is authorised after its hold expired, `confirm` checks capacity again. If places are free, the payment is captured. If not, the authorisation is cancelled.

## Refunds

Staff cancel tickets on a hosted reservation from **Occurrence → Sales**. The cancel then refunds those tickets' line amounts through Vipps, and the refund's reference is stored on the tickets as `externalRefundRef`. Staff confirm the amount first.

## Data

- `payments.provider_account`: one connected merchant per account and provider. It holds the encrypted keys and webhook secret, the status and the history.
- `payments.payment`: one per hosted reservation. It holds the reference (also the reservation's `externalOrderRef`), the amount, the state, and Vipps' last aggregate.
- `payments.refund`: the amount, the ticket ids and the idempotency key.
- `tenancy.account`: the merchant details.
- `offers.sales_channel.kind`: `hosted`, at most one per account.

Every table has row-level security (ADR 0004). Migration `0030_payments` also moves the data key to `platform.data_key`, as the HubSpot branch does, and leaves a view at the old name for the rolling deploy.

## Configuration

- `VIPPS=http` calls Vipps.
- `VIPPS=fake` uses an in-memory Vipps. It is the default outside production, and it is refused in production.
- `VIPPS=off` leaves payments off. It is the default in production.
- `PUBLIC_URL`: the core API's public base URL, for the webhook.

## Milestones

1. **Foundations** (this branch): ADR 0018 and this document; the secrets move to `shared`; migration 0030; `packages/vipps` (client, fake, webhook signatures); the payments module (connect, verify, disconnect); merchant details; Settings → Payments.
2. **Buy flow**: attendee pages, `startCheckout`, `processPayment` (confirm, capture and cancel), the tickets and receipt emails, enabling the hosted channel.
3. **Webhooks and reconciliation**: the webhook route, the worker job, the reconcile cron, and how expiry interacts with payments.
4. **Refunds and admin visibility**: staff refunds of whole or partial reservations, payment state in Sales, outbox events.
5. **Distribution and pilot**: the ticket link in the admin, `checkoutUrl` in the public API, and a run-through in the Vipps test environment with a pilot client.

## Out of the first release

Stripe and cards, group prices in checkout, discount codes, several occurrences in one basket, Vipps partner keys, and an event listing page.

## Acceptance scenarios

- Happy path: tickets are issued, and the payment is captured once.
- The buyer rejects the payment: the hold is released.
- Authorised after the hold expired, with places still free: confirm and capture.
- Authorised after the hold expired, with the event sold out: the authorisation is cancelled, and no tickets are issued.
- A duplicate webhook plus the return page: exactly one confirm and one capture.
- A partial refund.
- A second tenant sees none of it.

## Pilot checklist

- Connect a Vipps **test** merchant (MT) in the admin, and verify it.
- Pay on `/b/:occurrenceId` with the Vipps test app.
- Check that the tickets email arrives, the receipt is correct, Sales shows the payment as captured, and a refund appears in the Vipps test portal.
