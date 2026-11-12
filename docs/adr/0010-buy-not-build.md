# 0010 – Buy, don't build

**Status:** Accepted · 2026-11-12

Commodity capabilities with high risk and little differentiation are bought:

| Capability | Choice | Notes |
|---|---|---|
| Identity provider | Managed OIDC IdP | Vendor open, see 0005 |
| Transactional email | Postmark (SendGrid as fallback) | One branded template per tenant |
| Waiting room | Queue-it | Phase 2; core API verifies the queue token on hold creation |
| Wallet pass signing | Maintained libraries for Apple PassKit and Google Wallet API | Certificates per tenant or shared, to decide |
| Payments | Not in scope until hosted checkout (phase 3): Vipps MobilePay, Stripe | |

Everything that defines the product – catalog, recurrence, rules, inventory, admissions, validation, the integration contract – is built.
