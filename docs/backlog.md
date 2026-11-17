# Backlog

Features we want but haven't scheduled. An entry here is a problem and a direction, not a spec. When one is picked up it gets its own document like [registration.md](registration.md).

## Dynamic QR codes

**Problem.** The QR code in the confirmation email ([registration.md](registration.md), Admission) is static. Anyone with a screenshot or a forwarded email can get in, and the same code can be resold or shared. At the door, a copy and the original look the same.

**Direction.**

- **Optional per event**, off by default. It adds a login step to the attendee journey, so it is for events where fraud is a real risk (popular free events, paid tickets), not for every gala.
- When it is on, the email no longer carries a usable QR code. It links to a ticket page that shows a **rotating code** (for example, a new one every 15–30 seconds), derived from the admission and the current time window and signed so it can't be forged.
- **Simple attendee authentication:** a one-time code sent to the registration email. This verifies that the person holds the email; it is not an account. It extends ADR 0005 ("attendees: no accounts, signed tokens") with a short-lived, device-bound session that the ticket page uses.
- The rotating code still carries the admission and party size, so the validator can admit "2 of 2" as before.

**Things to work out.**

- **Offline validation** (ADR 0006): the validator checks QR signatures locally. A rotating code must also be verifiable offline, which means checking the time window against the device clock with a tolerance for clock drift.
- **Screen recording or live sharing** of the ticket page still works. Rotation stops screenshots and forwarded emails, not someone streaming their screen. First scan wins, and the scan log flags repeats.
- **Fallback** for attendees without a working phone at the door: staff look them up by name on the door list, with ID.
- **Session length and devices:** how long the OTP session lasts, and whether a ticket can be open on more than one device at once.
- **Turning it on after registrations exist:** existing static codes stop working, so attendees need an email telling them where to find their ticket.
- **Wallet passes** (Apple/Google) may support rotating barcodes natively and could replace the ticket page for some attendees.

**Depends on:** the validator app with scan log; the registration core (admissions and tokens) from registration milestone 2.

## Ticket transfer

*Follow-up to dynamic QR codes.*

**Problem.** Once tickets are bound to a verified email, attendees who can't go have no legitimate way to hand their place to someone else. They'll share their login code instead, which defeats the point.

**Direction.**

- The ticket holder enters the recipient's email on the ticket page. The recipient gets an email, verifies with an OTP and accepts. The admission moves to them, the old holder's codes stop working, and the change is logged.
- **Per-event setting**: allowed, not allowed, or allowed until a deadline before the event.
- Invite-only events: whether a transfer needs staff approval, since the guest list was chosen on purpose.
- Outbox event `admission.transferred`, so a CRM or MA connector can update the contact.
- **Out:** resale and payment between attendees. Moving money stays with ticketing.

**Depends on:** dynamic QR codes (verified attendee email); the registration form answers question (does the recipient fill in the form again, e.g. dietary needs?).
