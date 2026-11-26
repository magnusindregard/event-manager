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
4. The buyer approves or rejects in the Vipps app. Vipps sends the buyer back to `/b/return/:token`, a signed token with the `checkout` purpose that names the tenant and the payment. Vipps also sends a webhook.
5. `processPayment(reference)` runs from the return page, the webhook job and the reconcile job. It is idempotent and reads Vipps as the source of truth:

| Vipps says | Platform does | Payment state |
|---|---|---|
| CREATED | nothing yet (the return page waits and refreshes) | `created` |
| AUTHORIZED | `confirm(externalOrderRef = reference)`, then capture the total | `authorized` → `captured` |
| AUTHORIZED, but confirm fails (sold out after the hold expired, or the occurrence changed) | cancel the authorisation; no tickets | `cancelled` |
| ABORTED (the buyer said no) | cancel the reservation, releasing the places | `failed` |
| EXPIRED | cancel the reservation | `expired` |
| TERMINATED | cancel the reservation if it is still held | `cancelled` |

6. On confirm, the buyer gets the tickets email (the hosted channel sends tickets). On capture, the worker sends the receipt email. It also attaches the receipt to the payment in the Vipps app (Order Management API); that is best effort, and the email is the receipt of record.

**Enabling.** Owners enable the checkout under Settings → Payments once Vipps is connected. This creates the sales channel `hosted-checkout` ("Checkout"). It holds places for 20 minutes and emails tickets. VAT classes without a SKU there get `TICKET-<code>`, which staff can change. Offers created afterwards are on sale there by default, as on every active channel. Older offers are added to it in the offer editor. Free tickets (a total of 0) are confirmed at once, without Vipps.

**Pages.** The buy page lets the form go on to Vipps' domains (`form-action`, because browsers check it on the redirect too). The return page settles the payment itself before it shows anything. While Vipps still waits for the buyer, it refreshes every 3 seconds. Tokens in `/b/return/` are hidden in logs, like the other attendee links.

**Webhooks and reconciliation.**
- `POST /webhooks/vipps/:accountId/:providerAccountId` checks the signature with the provider account's secret. The host it checks is `PUBLIC_URL`'s, because behind Front Door the request carries the origin host. A valid webhook queues `payments.process` for the payment (job key `payment:<id>`, so a burst runs once) and answers 200. Webhooks for references the platform does not know are acknowledged and ignored. A bad signature gets 401; an unknown account gets 404.
- `payments:reconcile` runs every minute in the worker. It settles payments that have sat in `created` or `authorized` for 2 minutes, in case no webhook came.
- When the sweeper expires a hold whose payment still waits, `payments.abandon` cancels the payment at Vipps. If the buyer approved meanwhile, the payment is settled as usual instead.

**Expiry.** If the reservation sweeper expires a hold whose payment is still `created`, the payment is cancelled at Vipps. If a payment is authorised after its hold expired, `confirm` checks capacity again. If places are free, the payment is captured. If not, the authorisation is cancelled.

## Refunds

Staff (`sales.write`) cancel tickets of a hosted sale from **Occurrence → Sales**, all of them or the ones they tick. The dialog shows the amount, and the request carries it (`POST /v1/sales/reservations/:id/refund` with `amount`). If the tickets cost something else by then, it is refused, so staff never refund an amount they did not see.

1. One transaction cancels the tickets (their places go back on sale) and records a pending refund. The refund's idempotency key is also the tickets' `externalRefundRef`.
2. The refund goes to Vipps with that key.
3. The refund is marked `done` (`payment.refunded.v1`) or `failed` with Vipps' reason.

If Vipps does not answer, the refund stays `pending` and the reconcile job sends it again. If Vipps refuses it, staff see the reason in Sales and can retry (`POST /v1/sales/refunds/:id/retry`). Every attempt uses the same key, so the money moves once. A refund never exceeds what was paid.

The plain cancel (`/cancel`) refuses reservations paid in the hosted checkout, because it would cancel the tickets without giving the money back.

**In Sales**, each hosted order shows its Vipps state, how much has been refunded, and any refund that is pending or failed, with a retry button. A cancelled ticket says whether its refund is done, pending or failed.

## Data

- `payments.provider_account`: one connected merchant per account and provider. It holds the encrypted keys and webhook secret, the status and the history.
- `payments.payment`: one per hosted reservation. It holds the reference (also the reservation's `externalOrderRef`), the amount, the state, and Vipps' last aggregate.
- `payments.refund`: the amount, the ticket ids and the idempotency key.
- `tenancy.account`: the merchant details.
- `offers.sales_channel.kind`: `hosted`, at most one per account.

Every table has row-level security (ADR 0004). Migration `0030_payments` also moves the data key to `platform.data_key`, as the HubSpot branch does, and leaves a view at the old name for the rolling deploy.

## Configuration

- `VIPPS=http` calls Vipps (API, attendee app and worker).
- `VIPPS=fake` uses an in-memory Vipps. It is the default outside production, and it is refused in production. In the attendee app, it adds `/b/fake-vipps/:reference`, a page to approve or reject the payment. Set `VIPPS_FAKE_STATE` to a file path on the API and the attendee app so they share one fake Vipps; otherwise refunds from the admin cannot find payments made on the buy page. The worker's payment jobs stay off with the fake.
- `VIPPS=off` leaves payments off. It is the default in production.
- `PUBLIC_URL` (API): the public base URL, for the webhook and its signature check.
- `ATTENDEE_URL` (attendee app): its public base URL, where Vipps sends buyers back. Required with `VIPPS=http`.

## Milestones

1. **Foundations** (done): ADR 0018 and this document; the secrets move to `shared`; migration 0030; `packages/vipps` (client, fake, webhook signatures); the payments module (connect, verify, disconnect); merchant details; Settings → Payments.
2. **Buy flow** (done): attendee pages, `startCheckout`, `processPayment` (confirm, capture and cancel), the tickets and receipt emails, enabling the hosted channel.
3. **Webhooks and reconciliation** (done): the webhook route, the worker job, the reconcile cron, and how expiry interacts with payments.
4. **Refunds and admin visibility** (done): staff refunds of whole or partial reservations, payment state in Sales, outbox events.
5. **Distribution and pilot** (built; the pilot is still to run): the ticket link in the admin, `checkoutUrl` in the public API, the infra switch (`VIPPS_PAYMENTS`, infra/README.md 4e), and a run-through in the Vipps test environment with a pilot client.

## Distribution

- **Ticket link.** Occurrence → Sales in the admin shows the occurrence's ticket link (`<attendee app>/b/<occurrence>`), with copy and open buttons. It appears when the event is published, the checkout is enabled and Vipps is connected. Clients put it on their own site, in social posts or on HubSpot pages.
- **Public API.** A ticketed occurrence's `admission` is `{ "mode": "tickets", "checkoutUrl": … }`. `checkoutUrl` is the same link when the checkout can sell there: the hosted channel is active, Vipps is connected, and an offer on sale at the occurrence is on the hosted channel. Otherwise it is null. A frontend can show a "Buy tickets" button without knowing anything else about the checkout. Events have no link of their own, because a checkout covers one occurrence.

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

Before:
- Staging has the master key (infra/README.md 4d), `VIPPS_PAYMENTS=true` (4e), a real mailer, and `PUBLIC_URL` on the api (Front Door), so webhooks arrive.
- The pilot client has a Vipps MobilePay **test** merchant (MT) with ePayment, and the Vipps test app on a phone with a test user.
- The account has merchant details and a VAT class for its tickets.

Run:
1. Settings → Payments: connect the test merchant (environment Test), and check that it says connected and that the webhook is registered.
2. Enable the checkout. Put the event's ticket types on the "Checkout" channel, and check the SKUs.
3. Open the ticket link from Occurrence → Sales. Buy two tickets and pay in the Vipps test app.
4. Check: the receipt page, the tickets email with QR codes, the receipt email (VAT, organisation number), the receipt in the Vipps app, and "Vipps: betalt" in Sales. The payment should show as captured in the Vipps test portal.
5. Reject a payment in the app: the page says no money was taken, and the places are back.
6. Start a payment and leave it: after the hold (20 minutes), the payment is cancelled at Vipps.
7. Refund one ticket from Sales: it shows as refunded in Sales and in the Vipps test portal, and the buyer sees it in the app.
8. Check that `checkoutUrl` appears in the public API for the occurrence.

After: decide with the client when to switch to production keys (Settings → Payments, environment Production).
