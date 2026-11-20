---
name: configure-event
description: Change an existing event in the event manager with a human, through the event-manager MCP tools. Use when the human wants to edit an event's details, add or move dates, change capacity, registration or ticket settings, add ticket types, or set up weekend prices, seasonal capacity and similar rules. Reads the current set-up first, previews changes, and gets approval before saving.
---

# Configure an event with your human

You are changing an event on behalf of a staff member, with their permissions. Read first, change only what they asked for, and show the effect before you save.

## 1. Find the event and read its set-up

1. If you do not have the event id, call `list_events` with `q` (a word from the title or slug). If several match, show them (title, status, next date and the admin link, `adminUrl`) and ask which.
2. Call `get_event_configuration`: the event, its series, its upcoming dates, its ticket types and its rules, each with its `version`.
3. Call `get_account` if you need locales or the timezone, and `list_locations`, `list_tags`, `list_user_groups` or `list_vat_classes` when the change involves them.

Answer questions about the event from this data, in plain language. Say where a value comes from when it matters: the event's default, a rule, or an override on that date.

## 2. Work out the change

Map the request to the smallest change that does it:

| The human wants | Tool | Note |
|---|---|---|
| New title, description, image, place, duration, tags | `update_event` | Only the fields given change. A translation replaces that locale's translation |
| Different capacity, sign-up window, waitlist, reminder | `update_event` with `registration` | Merges per field |
| Invitation only, or open to all | `update_event` with `registration.accessPolicy` | Invitation only hides it from listings unless `listed` is given |
| Only for members (user groups) | `update_event` with `accessGroupIds` | Replaces the list; empty opens it to everyone |
| Different capacity, price or link **on some dates** (weekends, summer, evenings) | `create_rule` / `update_rule` | Conditions: dates, weekdays, start times, in the event's timezone. Effects: capacity, overbooking, location, tags, link, an offer's price (optionally for one group), an offer on or off sale |
| Something different **on one date** | `update_occurrence` | Overrides that date only; changing its time detaches it from the series |
| Cancel one date | `update_occurrence` with `status: "cancelled"` | Ask first: registrations and tickets for that date are affected |
| More dates, or a different weekly pattern | `create_series` / `update_series`, or `create_occurrence` | |
| A new ticket type, or a new price for one | `create_offer` / `update_offer` | Prices in minor units including VAT; a new default price applies to every date |
| A price for members | `update_offer` with `groupPrices` | Replaces the list; groups not listed pay the general price |

Ask a focused question when the request is ambiguous: "raise the price" (which ticket type, by how much, from when?), "next weekend" (which dates exactly?), "make it bigger" (capacity on all dates or some?). If the request conflicts with the set-up (a ticket price on a registration event, a rule that a higher-priority rule overrides), explain it and ask.

Rules have a `priority`: higher wins; on a tie the older rule wins and the tie is reported. If a new rule would be overridden, say so.

## 3. Preview and review

- For rules and series, call the tool with `dryRun: true` first. Tell the human how many dates change, show a few examples and any conflicts or removed dates.
- For other changes, state the before and after of each field.
- Then follow the review-event skill: what will change, what stays, assumptions, open points. Get a clear yes.

## 4. Save

Call the tool without `dryRun`, with the `version` from your latest read. If the result is `version_conflict`, someone else changed it: read it again with `get_event_configuration`, tell the human what changed, and ask before retrying.

Publishing, unpublishing and cancelling the whole event affect what the public sees: do them only when the human says so explicitly, after the review. Deleting and archiving are not available through these tools; point the human to the admin.

## 5. Confirm

Read the event again and tell the human, briefly, what is now true: the fields that changed and, for rules, the dates they now apply to. End with the link to the event in the admin (`adminUrl`, or `eventAdminUrl` in the result of a change to its dates, ticket types or rules).
