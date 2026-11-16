# 0012 – Staff identity provider: Microsoft Entra External ID

**Status:** Accepted · 2026-11-13, revised 2026-11-16 after the first sign-in test against a real tenant (revised before merge) · Settles the IdP vendor left open in [0005](0005-identity-and-access.md)

## Context

Staff of client organisations sign in to the admin. Most of them have a work account in their own
organisation's Entra ID (or Google Workspace); some, at smaller venues, do not.

Testing against a real External ID tenant (see `infra/README.md`, *Entra pitfalls*) showed:

- **Sign-in with tenant tokens works end to end.** Issuer, audience and the `email` optional claim on the access token
  arrive as the API expects, and invitations match on that email.
- **A work account cannot simply sign in.** Entra sends it to its home tenant, then refuses it with `AADSTS50020`
  because the account is unknown in our external tenant. Every client user with a work account needs either a
  guest (B2B) invitation in our tenant or federation with their organisation's tenant first.
- **Self-service sign-up was not offered** to the admin app, even with the app in a sign-up/sign-in user flow.
  The cause is not known. Users created directly in the tenant sign in fine.

## Decision

- Staff sign in through an **Entra External ID** (external tenant) app registration. The admin uses MSAL.js
  (authorization code + PKCE) with an authority that names the tenant by ID:
  `https://<prefix>.ciamlogin.com/<tenant-id>/`. MSAL rejects the tenant's issuer with any other form.
- The API verifies access tokens against the tenant's JWKS (`jose`), checking issuer and audience (the API app's
  client ID, since tokens are v2).
- **Access is invitation-only. Public sign-up is not used.** Identities exist in the tenant because we created them.
- **Our invite flow provisions the Entra identity.** When an owner invites someone in the admin, the API also
  creates the identity in the external tenant through Microsoft Graph, so owners never need Entra admin access:
  - **Work accounts** (the address belongs to an Entra or federated organisation) become **guest users** (B2B
    invitation). They authenticate at their own organisation, so its MFA, conditional access and offboarding
    apply: disabling the account at home blocks sign-in here, without per-client federation.
  - **Other addresses** become **local customer accounts** with email sign-in through **one-time passcode**.
    No passwords to deliver or reset, and each sign-in proves control of the mailbox.
  - **Telling them apart** (decided in milestone 2): a realm lookup (`login.microsoftonline.com/common/userrealm`)
    on the address. `Managed` or `Federated` means a work account. Well-known consumer domains (gmail.com,
    outlook.com …) are always local. The owner can override this per invitation ("work account" or
    "one-time code"), and that choice wins.
  - **Local accounts** are created with `POST /users` and an `emailAddress` identity issued by
    `<prefix>.onmicrosoft.com`. Graph requires a password, so a random one is set and never shown; the user flow
    signs them in with a one-time passcode.
  - An identity that already exists for the address (a person in several accounts) is reused, not duplicated.
  - The **worker**, not the API, calls Graph. It runs on the `member.invited.v1` outbox event as an
    `invitation.provision` job (one per invitation, retried with backoff), and records the outcome on the
    invitation. It uses an app registration in the external tenant with the least permissions that work
    (`User.Invite.All` for guests, `User.ReadWrite.All` for local accounts). In Azure it authenticates with a
    federated credential from its managed identity, so there is no client secret. Locally and in tests, Graph is
    replaced by a fake (`IDENTITY_DIRECTORY=graph` turns on the real one).
- **Federation with a client's own tenant** (OIDC identity provider per organisation) is optional, for clients
  that require it. Guests already give single sign-on with their work account.
- Identity in our database is `(issuer, subject)`. Email is used once: to accept a pending invitation on first
  sign-in (`tenancy.login`; `GET /v1/me` always re-checks, so a new invitation applies on the next page load).
- Authorization stays in our database (0005). The admin sends `Account-Id`, and the API looks up the user's roles
  in that account under RLS. "No such account" and "not a member" give the same 403.
- Local development and tests use HS256 tokens signed with `AUTH_DEV_SECRET`. The API refuses to start with that
  secret when `NODE_ENV=production`.

## Why

Azure-native, EU data residency, priced per monthly active user (staff counts are small), and guest access lets
client staff use their existing work accounts. Provisioning from our own invite flow keeps "who may sign in" and
"who may do what" in one place for owners, while Entra handles authentication.

Auth0 Organizations has a stronger per-organisation SSO model and stays the fallback if Graph provisioning or guest
management turns out to be a burden.

## Consequences

- Inviting someone has two steps: our invitation row, then the Graph call. If Graph fails, the invitation is kept,
  marked as failed with the error, and retried by the worker; the owner sees the state on *Users* and can retry.
  Removing a member removes our membership only. The Entra identity is kept, since a person may belong to several
  accounts, and without a membership it grants nothing. Cleaning up identities with no membership is left for later.
- Guest invitations are created with `sendInvitationMessage: false`, so the guest gets one email: ours (Postmark,
  ADR 0010), with Microsoft's redeem link and a short explanation. A guest who skips the link redeems on first
  sign-in to the admin.
- Invitation matching trusts the email claim. That holds because every identity is created by us for the invited
  address (guests are verified by their home organisation; local accounts by one-time passcode). If public
  sign-up is ever enabled, require email verification or an invitation link token first.
- The bootstrap owner created by the CLI is provisioned the same way (`createAccount` emits `member.invited.v1`).
- The External ID tenant, its app registrations, user flow and the Graph app registration are configured
  manually; they are not in Bicep.
