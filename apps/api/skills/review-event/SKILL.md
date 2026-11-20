---
name: review-event
description: Summarise an event, or a proposed new event or change, for a human to review before it is saved or published in the event manager. Use before any create or change through the event-manager MCP tools, and when the human asks what an event is set up like. Makes defaults, assumptions and open questions explicit.
---

# Review an event with your human

A review lets the human catch mistakes before they reach the public. Write it for someone who knows the event but not the system: plain words, their dates and prices, no field names or ids.

## What to include

**1. What happens.** One line: "Create a draft event", "Change the weekend price", "Publish the event".

**2. The event as it will be**, only the parts that apply:

- Title (and the languages it has)
- Where, and how long each time
- When: the pattern and the first and last date, or the list of dates, in the event's local time with the timezone named once ("Tuesdays 14:00–15:00, 2 March to 8 June 2027, 15 dates, Oslo time")
- How people get in: drop in, a link elsewhere, sign-up here, or tickets
- Places per date, and whether there is a waitlist or overbooking
- Tags (audience, category and so on), or that it has none
- Ticket types and prices including VAT, with the currency ("Adult NOK 150, Child free")
- Variations by rule: "Saturdays and Sundays: Adult NOK 180"; "June to August: 40 places"
- Who it is for: everyone, by invitation, or only certain groups
- Whether it shows in public listings
- Status: draft (not public) or published

For a change, show **before → after** for each field that changes, and say that everything else stays as it is.

**3. Defaults applied.** Settings the human did not choose that you left at the default, e.g. "Sign-up closes when it starts", "No reminder email", "Shown in listings".

**4. Assumptions.** Everything you inferred rather than were told, e.g. "I took 'spring' as 2 March to 8 June", "I assumed one hour per tour", "Prices include VAT".

**5. Open points.** Anything still undecided, and what happens if it stays open ("No image yet: the website shows the event without one").

**6. The question.** Ask for a clear yes to go ahead, or what to change. For publishing, ask separately and say that the event becomes visible on the website.

## Keep it honest

- Do not present a guess as a fact. If a date conversion or price is uncertain, say so.
- Mention side effects: a moved series moves its dates; a removed date or a cancelled event affects people who registered or bought tickets; a new default price applies to every date.
- After saving, read the event back and report what actually was saved, not what you intended, with the link to the event in the admin (`adminUrl`).
- Whenever you list events for the human, give each one's admin link (`adminUrl`) with its title, status and next date.
