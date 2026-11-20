---
name: create-event
description: Create a new event in the event manager with a human, through the event-manager MCP tools. Use when the human wants to add, set up or schedule a new event, exhibition, tour, concert, course or other programme item. Gathers the details step by step, asks only what is missing, and gets the human's approval before creating anything.
---

# Create an event with your human

You are setting up an event in the event manager on behalf of a staff member. The tools act with their permissions. Your job is to turn what they tell you into a correct event, asking as little as possible, and never inventing facts.

## 1. Start from what you already know

Before asking anything:

1. Call `get_account` for the account's **default locale**, the **locales** titles can be written in, and the **timezone**.
2. Call `list_events` with `q` set to a word from the title. If a similar event exists, show it with its admin link (`adminUrl`) and ask whether this is a new event, another date for that event (then follow the configure-event skill instead), or a copy of it.
3. Collect what the human has already said in the conversation, in pasted text, a web page or a document: title, dates, place, price, audience. Do not ask again for anything you already have; confirm it in the summary instead.
4. Call `list_locations`, `list_tags` and, if prices or audiences come up, `list_user_groups` and `list_vat_classes`, so you can offer existing choices rather than ask for ids.

## 2. Gather what is needed

Ask focused questions, a few at a time, in plain language. Skip any you can already answer.

**Always needed**

| What | Field | Notes |
|---|---|---|
| Title in the default locale | `translations.<locale>.title` | Offer to add other account locales; never machine-translate without saying so |
| How people get in | `admissionMode` | See the table below; explain it, do not ask for the word |
| When | a series or single dates | Added after the event is created (step 4) |
| Tags | `tagIds` | Always ask, offering the tags from `list_tags` grouped by vocabulary (e.g. audience, category) with your suggestions. The website filters on them. "None" is a valid answer; do not create new vocabularies |

**Usually needed**

- **Where**: `defaultLocationId`, a venue or a space in it. If it is not in `list_locations`, offer to add it with `create_location` (a space needs its venue as `parentId`).
- **How long** each time: `defaultDurationMin` (default 60). Ask if the human gave only start times.
- **Short description** and **image**: `shortDescription`, `imageUrl` (https), `imageAlt` per locale. Ask for alt text whenever there is an image.

**How people get in**: explain these in the human's words and ask which fits.

| Mode | Means | Then also ask |
|---|---|---|
| `none` | Drop in, nothing to book | Nothing |
| `external` | Tickets or sign-up elsewhere | The link, `externalUrl` |
| `registration` | Free sign-up (RSVP) here | Capacity per date, open to all or invitation only (`registration.accessPolicy`), waitlist, guests, when sign-up opens and closes, reminder email |
| `tickets` | Paid or free tickets sold through the account's sales channels | Capacity per date, and the ticket types (step 5) |

Defaults you may keep without asking, but must mention in the summary: shown in listings (`listed: true`), open to everyone, no overbooking, sign-up opens when the event is published and closes at the start, no waitlist, no guests, no reminder. Capacity has **no limit** unless set: always ask for it for registration and tickets.

**Only if the human brings it up**: restricting the event to user groups (`accessGroupIds`), a custom slug, external references, a timezone other than the account's.

### When something is unclear

- **Ambiguous dates** ("every Tuesday in spring", "the 3rd"): propose a concrete reading ("Tuesdays from 3 March to 9 June 2027, 14:00–15:00") and ask them to confirm.
- **Missing year, end time or timezone**: ask; do not assume next year or a one-hour slot silently.
- **Inconsistent facts** (a "free" event with a price, a drop-in event with a capacity): point out the conflict and ask which is right.
- **Prices**: confirm the currency amount including VAT; the API takes minor units (NOK 150 is `15000`).
- If the human does not know yet, leave it out, keep the event a draft, and list it as open in the summary.

## 3. Review before creating

Summarise the event as described in the review-event skill: what will be created, which defaults apply, what you assumed and what is still open. Ask for a clear yes. Do not create anything before it.

## 4. Create it, then its dates

1. `create_event` with an `idempotencyKey` (any unique string; reuse it if you retry the same call). The event is a **draft**. Give the human its admin link (`adminUrl` in the result) right away, so they can follow along there.
2. Recurring dates: `create_series` with an RRULE (e.g. `FREQ=WEEKLY;BYDAY=TU;UNTIL=20270609T235959`) and `dtstartLocal` in local wall time (`2027-03-02T14:00`). Call with `dryRun: true` first, show the human the first and last dates and the count, then call again without it.
3. Single dates: `create_occurrence` with `startUtc` as a UTC instant. Convert from the event's timezone carefully, including summer time.

## 5. Ticket types (tickets only)

For each ticket type (Adult, Child, Student, Family): a name per locale, a price including VAT, a VAT class from `list_vat_classes` (ask which if there are several; museums often sell tickets VAT-exempt), and a `code` (lowercase, e.g. `adult`). Ask about places per ticket (a family ticket may admit 4), limits per purchase and sales windows only if they matter to the human. Call `create_offer` once per type, each with its own `idempotencyKey`.

Weekend prices, a summer capacity or similar variations are **rules**: use the configure-event skill.

## 6. Finish

Call `get_event_configuration` and give a short final review: what was created, the dates, the ticket types, the tags, and the open points, ending with the link to the event in the admin (`event.adminUrl`). Say that the event is a **draft** and ask whether to publish it now. Call `publish_event` only on an explicit yes.

## Errors

Tool errors say what went wrong and what to do. `validation_failed` names the field: fix it if the fix is obvious (a typo in a URL), otherwise ask the human. `forbidden` means their role does not allow it: tell them, do not try another way.
