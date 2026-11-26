# 0018 – Hosted checkout and payments: Vipps MobilePay on the client's own merchant

**Status:** Accepted · 2026-11-25 · Refines 0010 (payments, phase 3) · Follows 0017 (HubSpot connector)

## Context

Ticketing (docs/ticketing.md) lets clients sell tickets through **their own** web shop or POS, which call `/v1/reservations`. The platform takes no payments. Some clients have no web shop and do not want one, so today they cannot sell tickets.

The platform already owns prices, VAT, holds, reservations, tickets and cancellations. We looked at Medusa as a ready-made shop and rejected it:

- It would duplicate that core.
- It has no Vipps provider.
- It reserves stock only when the order is placed, and it assumes shipping.
- Medusa Cloud runs outside Azure Norway East (ADR 0009).

## Decision

- The platform hosts a checkout: server-rendered buyer pages in the attendee app (ADR 0005, no buyer accounts). It is a **sales channel of a new kind, `hosted`**, at most one per account. It reserves and confirms through the same domain functions as any other channel, so it adds no new pricing, VAT or capacity logic.
- **Vipps MobilePay comes first** (the ePayment API). It sits behind a `PaymentProvider` interface in the domain, and Stripe can be a second adapter later.
- **Each client is the merchant.** Payments go to the client's own Vipps merchant account, using the keys the client enters in the admin. The platform is a **payment initiator, not the merchant of record**, and it never holds money. The keys are stored encrypted with the account's data key (`shared/secrets.ts`).
- The order is **authorise → confirm → capture**:
  1. Reserve (this holds the places and freezes the snapshot).
  2. Create a Vipps payment for exactly the reservation's total.
  3. The buyer approves the payment in Vipps, which authorises it.
  4. `confirm`, with the Vipps reference as `externalOrderRef`.
  5. Capture.

  If `confirm` fails (for example `expired_sold_out`), the platform **cancels the authorisation**, so no money moves. That is cleaner than the refund the integration guide asks external shops to make. Capture happens right after the tickets are issued, because that is when the goods are delivered.
- Vipps is the source of truth for a payment's state. The return page, the webhook and a reconcile job all run one idempotent `processPayment(reference)`, which reads the payment at Vipps and moves the state machine forward.
- **Card data never touches the platform.** Vipps hosts the payment page and the app.

## Consequences

- The payments module owns `payments.provider_account`, `payments.payment` and `payments.refund`, with row-level security like every other module (ADR 0004).
- Clients onboard with keys from their own Vipps portal. Vipps partner keys could make onboarding easier later, without changing the model.
- Refunds of hosted sales go through Vipps when staff cancel tickets. The refund reference is stored on the tickets as `externalRefundRef`, like a shop's.
- Webhooks are signed per provider account (HMAC-SHA256), and the URL names the account. Where the platform has no public URL (local stacks), payments are found by polling.
- In the first release, one checkout covers one occurrence, at public prices. Group prices need buyer sign-in (docs/user-groups.md), and discount codes are not included.
