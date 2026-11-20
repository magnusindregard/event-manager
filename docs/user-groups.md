# User groups – group prices and access

*Draft, 20 November 2026. Builds on [docs/ticketing.md](ticketing.md) and [docs/registration.md](registration.md). Issue #82. Decisions: [docs/adr](adr/README.md).*

## Goal

Let clients give **their own customer groups** (Member, Sponsor, Friends of the house) their own prices and their own events, without the platform knowing who their customers are.

- Staff set up **user groups** per account that mirror the groups the client's frontend already has.
- An offer can carry a **price per group**. A group with no price of its own pays what everyone pays.
- Price rules and per-occurrence overrides can target **one offer for one group**, just as they target an offer today.
- Events and offers can be **restricted to groups** ("member-only events", a "Member early bird" ticket type on an open event).
- Group prices and restrictions are **exposed in the public API**; the reservations API enforces them.

The platform does **not authenticate buyers** or assign groups. The client's frontend signs its users in and knows their groups; its server-side connector says which group a buyer belongs to when it reserves (ADR 0005: attendees have no accounts).

## Scope

### In

- **User groups** per account: code, localized name, sort order, archive.
- **Group prices** per offer, **group overrides** per (offer, occurrence, group) and **group targets** on `price` rule effects, resolved and materialized like general prices.
- **Access**: groups allowed per event and per offer.
- **Reservations**: an optional `group` on reserve, checked against access and used for the price, frozen in the snapshot.
- **Public API**: access flags, group prices, and a `?group=` view.
- **Admin**: Settings → User groups, group prices and "who can buy" in the offer editor, a group selector in the price grid, a group on price effects, "who can attend" on the event, sales by group.
- **Outbox** events for groups.

### Out, and how this prepares for it

| Out of scope | Prepared by |
|---|---|
| Verifying a buyer's group | The group is asserted by the channel connector, which is server-side and holds a secret key; a hosted checkout (epic #17) would assert it after its own sign-in |
| Relative group prices ("10 % off for members") | The `price` effect's value is an object, so `{ percentOff }` can be added beside `{ amount }` |
| Member presale windows | Group prices are rows per (offer, group), so they can gain window columns |
| Exclusions ("no student price for sponsors") | Only allow-lists can be enforced, since any buyer can reserve without a group; exclusions stay in the frontend |
| Self-registration by group for registration events | A trusted register-on-behalf endpoint for connectors; until then invitations do the job |
| Per-occurrence access | A member-only offer, or a separate event |
| Quotas per group | Multi-pool holds (ADR 0003), as for quotas per offer |

## Data model

### User group (account)

- `catalog.user_group`: `code` (`^[a-z0-9][a-z0-9_-]{0,62}$`, unique per account, **cannot change**), `names` per locale, `sortOrder`, `archivedAt`, `version`. At most 50 per account.
- The code is what the frontend and the connector use. A frontend that renames a group creates a new one and archives the old.
- Groups are **archived, never deleted**. Archiving is refused while an event or offer that is not archived names the group in its access list: removing it would quietly open the event to everyone. An archived group's prices, overrides and rule effects stay stored but are not read: public reads and reservations see active groups only.

### Access

- `catalog.event_access_group (event_id, group_id)` and `offers.offer_access_group (offer_id, group_id)`, exposed as `accessGroupIds`. An empty list means open to everyone.
- A buyer may buy an offer when both the event's and the offer's lists are empty or contain the buyer's group.
- Restricting does not change `listed`: restricted events are listed and flagged, and the frontend decides how to show them.

### Group prices

- `offers.offer_group_price (offer_id, group_id, amount)`: the group's own price for the offer, in minor units including VAT.
- `offers.offer_group_override (offer_id, occurrence_id, group_id, amount)`: one group at one occurrence.
- `price` rule effects gain an optional **group**: "Weekend: Adult 500, Adult for members 400" is one rule with two effects. `offerAvailable` has no group.
- `offers.effective_group_price (occurrence_id, offer_id, group_id)`: materialized, with source and rule id, **only where the group's price differs** from the general one (sparse).

## Price resolution

For an offer and group G at an occurrence, the most specific setting wins:

1. the group override for (offer, occurrence, G);
2. the highest-priority matching rule with a `price` effect on (offer, G); ties are reported per (offer, G);
3. the offer's group price for G;
4. otherwise the **general price**, resolved as today: override → rule → offer default.

Example: Adult 450, a weekend rule sets Adult to 500, Member price 350. Members pay 350 every day; Sponsors, with no price of their own, pay 450 on weekdays and 500 at weekends. A weekend member price is a member effect on the weekend rule.

A general rule or override does not move a group's own price. This is the meaning of "a group price": someone who sets "Member 350" means members pay 350. A group with nothing of its own gets whatever everyone else gets.

Since a group row exists only where steps 1–3 matched, the resolver's work per occurrence grows with the number of group prices configured, not with offers × groups, and the inline limit of 2,000 occurrences stays.

## Reservations API

- `POST /v1/reservations` takes an optional `group` (a code) for the whole reservation.
- Reasons, each with `details.line`:
  - `unknown_group` (422): no active group with that code in the account.
  - `group_required` (403): the event or offer is restricted and no group was given.
  - `group_not_allowed` (403): the group is not on the event's or offer's list.
- The line is priced with the group's effective price when there is one, else the general price, and the group code is frozen in the snapshot.
- Signatures move to `reservation_line.v2` and `reservation.v2`, with the group code appended. The integration guide is not published yet, so no connector checks v1.
- `extend` checks the group again; `confirm` does not, as it does not recheck sales windows: the buyer has paid for a valid hold.

## Public API

- Events, summaries and offers gain `access: { groups: [{ code, name }] }`, empty when open.
- `PublicOffer.price` stays the general price. `groupPrices: [{ group, price }]` lists the groups that have their own price at that occurrence and may buy the offer.
- These are the same for every caller, so caching is unchanged.
- `?group=code` on `/public/occurrences` and `/public/events/{idOrSlug}` gives the view for one group: `price` is that group's price, offers it may not buy are left out, and availability is counted over the offers it can buy. It is a projection of public data, not access control; the query string is already the cache key. An unknown code is 400 `unknown_group`.
- A restricted registration event has no `admission.url`.

## Registration

The hosted attendee app cannot know a user's group. A restricted registration event therefore behaves like `invite_only` for attendees: there is no `/r/` link, and signing up gives `invitation_required`. Invitations, staff registrations and the guest import work as before.

## Admin interface

- **Settings → User groups**: code, name per locale, order, archive and restore.
- **Event → Settings**: "Who can attend": everyone, or only these groups. Registration events show that attendees must be invited.
- **Event → Ticket types**: group prices ("groups not listed pay the default price") and "Who can buy".
- **Event → Prices**: a group selector above the grid. A group's cells show the source (group override, rule, group price) or the general price greyed out as inherited; the popover sets the group override.
- **Rules**: price effects take a group, default "All buyers".
- **Occurrence → Sales**: sold and revenue per group.

## Permissions

- User groups: `account.write`; any member can read them.
- Event access: `content.write`, like the access policy.
- Offer access, group prices, group overrides and group price effects: `offers.write`.

## Outbox events

`user_group.changed.v1` (create, update, archive, restore). Group prices emit `offer.changed.v1` and `price.changed.v1` as general prices do; offer access emits `offer.changed.v1` with `resolution: "none"`; event access emits `event.changed.v1`. `reservation.held.v1` carries the group code.

## Milestones

1. **Groups and access:** user groups (API, admin), event and offer access, public access flags, registration gating, `group` on reserve and extend with the three reasons, the group in the snapshot and v2 signatures.
2. **Group prices:** group prices, group overrides, group targets on price effects, resolution and materialization, rule preview, admin editor, grid and rule editor, copying offers.
3. **Group prices out:** public `groupPrices` and `?group=`, availability per group, reservations priced by group, sales by group, the groups section of the integration guide.

### Status

*Milestone 1 (groups and access)* is built and tested locally (20 November 2026): `packages/domain/test/acceptance/user-groups.test.ts` covers groups, archiving, the member-only event and offer, extend, copying, the members' registration event and tenancy; `apps/api/test/user-groups.test.ts` the endpoints; `apps/public-api/test/public.test.ts` the access flags with caching unchanged; `packages/db/test/rls.test.ts` the three new tables. Decisions taken while building:

- **Tables.** `catalog.user_group`, `catalog.event_access_group` and `offers.offer_access_group` (migration `0020_user_groups`). `sales.reservation` gains `group_id` and `group_code`, and `sales.reservation_line` gains `group_code` in its snapshot. Endpoints: `GET`/`POST /v1/user-groups` and `PATCH /v1/user-groups/{id}` with If-Match; events and offers take and return `accessGroupIds`, which replaces the list.
- **Names** are per locale (`names`), like tag labels; at least one is required.
- **Archived groups on a list.** An event or offer keeps an archived group that is already on its list, and the restriction still holds; a group cannot be newly added once archived. `usedBy` counts events and offers that are not archived, and only those block archiving.
- **Registration.** The registration target reports `accessPolicy: invite_only` for a restricted event, so the attendee pages and `register` refuse attendees without a separate check, and the public `admission.url` is null.
- **Reasons.** `group_required` and `group_not_allowed` carry `details.line` and the codes on the list (`groups`); `group_not_allowed` also carries the buyer's `group`. An unknown or archived code is `unknown_group` with `field: "group"`.
- **Signatures.** The line text is `reservation_line.v2` with the group code last; the reservation text is `reservation.v2` with the group before the line signatures. The HMAC prefix stays `v1.`.
- **Prices** are still the general prices in this milestone; group prices arrive with milestone 2 and are used by reservations in milestone 3.

*Milestone 2 (group prices)* is built and tested locally (20 November 2026): `packages/domain/test/rules.test.ts` covers the engine (the fallback order, ties per offer and group, group targets on price only); `packages/domain/test/acceptance/user-groups.test.ts` the 450/500/350 scenario, a member effect on the weekend rule with its preview, general and group overrides, removing a group price, permissions and copying; `apps/api/test/user-groups.test.ts` the endpoints; `packages/db/test/rls.test.ts` the three new tables. Decisions taken while building:

- **Tables.** `offers.offer_group_price`, `offers.offer_group_override` and `offers.effective_group_price` (migration `0021_group_prices`), and `rules.rule_effect.target_group`, unique with the rule, type and target. Group overrides have their own table, so `offer_override` keeps its key.
- **Sparse rows.** The resolver replaces an occurrence's group rows on every resolution and writes only pairs where a group setting applied; `amount_source = 'default'` is the offer's group price. A pair appearing or going away counts as a price change in `price.changed.v1`.
- **Pairs resolved** per occurrence: the offers' group prices, the rules' group effects and that occurrence's group overrides. Archived groups keep being resolved; readers that buyers see ask for active groups only.
- **Rule effects.** A `price` effect takes an optional `targetGroup`; responses carry it only when set. `offerAvailable` takes none. The general price ignores group effects. Group effects need an active group when added, like offers. The preview reports group changes with `group`, showing the general price for a group without its own; `conflicts[]` carries `group` too.
- **Endpoints.** Offers take and return `groupPrices: [{ groupId, amount }]`, which replaces the list and resolves the event. `PUT`/`DELETE /v1/offers/{id}/occurrences/{occurrenceId}/groups/{groupId}/override` with `{ amount }` set and clear a group override and return the group's cell. `GET /v1/events/{id}/prices?groupId=` adds `group: { groupId, price, inherited, override }` to each cell.
- **Admin.** Group prices in the ticket type editor (empty: the general price), "Pris for" in the price grid, with inherited cells greyed and a popover for the group override, and a price per group under each ticket type in the rule editor.

*Milestone 3 (group prices out)* is built and tested locally (20 November 2026): `packages/domain/test/acceptance/user-groups.test.ts` covers the public group prices and `?group=` view, access per group, reservations priced by group with the snapshot kept through confirm, and sales by group; `apps/public-api/test/public.test.ts` `?group=` over HTTP. Decisions taken while building:

- **`groupPrices`** on a public offer lists active groups that have a price of their own at that occurrence and that both the event's and the offer's lists admit, each as `{ group: code, price }`. A group's price that it cannot use (the offer is limited to other groups) is left out.
- **`?group=code`** on `/public/v1/occurrences` and `/public/v1/events/{idOrSlug}`: offers the group may not buy are left out, `price` is the group's price (else the general one), and availability is counted over the offers that remain. Responses stay publicly cacheable; the code is part of the cache key. An unknown or archived code is 400 `unknown_group`, not cached. Listings of events take no `?group=`: they carry no prices.
- **Reserve** prices each line with the buyer's group price at that occurrence where one applies, else the general price, and freezes it like any other price.
- **Sales view.** Each offer has `byGroup`: valid tickets and revenue per group code they were sold under, `null` for no group, listing only groups that sold. Reservations carry `group`. The admin shows the split under the offer when any group bought.
- **Outbox.** `reservation.held.v1` carries the group code (milestone 1); no new event types.

### For connectors

Until the ticketing integration guide (ticketing milestone 5) is written, this is what a shop needs to know:

1. **Mirror your groups.** Create one user group per group your site has, with the code your site uses. Codes never change; a renamed group is a new one.
2. **Show prices per visitor.** Read `/public/v1/occurrences?group=<code>` for a signed-in visitor, or read once without `group` and pick from `groupPrices`, falling back to `price`. Hide or lock events and offers whose `access.groups` the visitor is not in; that is a display decision, not a security one.
3. **Reserve with the group.** Send `group` on `POST /v1/reservations` from your server, after your own sign-in. Expect `group_required`, `group_not_allowed` (both with `details.line` and `details.groups`) and `unknown_group`.
4. **Charge the snapshot.** Each line's `unitPrice` is the group's price, frozen with `group`; signatures are `reservation_line.v2` and `reservation.v2`, with the group code in them.

## Acceptance scenarios

- Adult 450, weekend rule 500, Member 350: members pay 350 every day, sponsors 450 on weekdays and 500 at weekends. A general override of 600 at one occurrence leaves members at 350; a member override of 300 there wins.
- A member-only ticketed event is listed with `access.groups: [member]`. Reserving without a group is `group_required`, as a sponsor `group_not_allowed`, as a member it succeeds at the member price with the group in the snapshot and its signature.
- A member-only offer on an open event: that line is refused for others, other offers sell to anyone.
- A registration event for members has no `/r/` link; an attendee who signs up is refused; an invited guest and a staff registration succeed.
- A group in use cannot be archived. Once archived, its prices leave the public API and reserving or extending with its code is `unknown_group`.
- A member price changed after reserve: confirm charges the snapshot.
- Another account's group code is `unknown_group`, verified by tests on every new table.

## Decisions

*Settled 20 November 2026, before building.*

1. **Groups are asserted, not verified:** the connector's channel key is the trust boundary.
2. **Prices:** a full group dimension. Rules and overrides can target (offer, group), and prices are materialized per group.
3. **Visibility:** restricted events are listed and flagged in the public API; reservations enforce.
4. **Registration:** restricted registration events are by invitation for attendees.
5. **Restrictions:** per event and per offer.
