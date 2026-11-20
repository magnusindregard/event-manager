// The curated MCP tool catalogue (docs/mcp.md). Each tool is one /v1 operation: its input
// schema is built from the route's schemas, and a call is dispatched to the route with the
// caller's own token, so validation, permissions and the audit log are the API's.
// Left out on purpose: deletes, archiving, price overrides, bulk edits, members, keys,
// channels and everything about registrations, guests and sales.

export interface OperationTool {
  name: string;
  operationId: string;
  title: string;
  description: string;
  /** read: no change. write: creates or changes something. */
  kind: "read" | "write";
  /** The route's `:id` as this argument name, e.g. eventId. */
  id?: string;
  /** The route requires If-Match: the tool takes the resource's `version` instead. */
  ifMatch?: boolean;
  /**
   * May overwrite, remove or hide something rather than only add (MCP destructiveHint): every
   * update and status change. Only creates are additive. Skills ask the human first either way.
   */
  destructive?: boolean;
  /** Repeating the call with the same arguments has no further effect. */
  idempotent?: boolean;
}

const VERSION_NOTE = " Pass the `version` from your latest read of it; if someone changed it since, the call is refused with the current version.";

export const OPERATION_TOOLS: OperationTool[] = [
  // ── Reading ──────────────────────────────────────────────────────────────────
  {
    name: "get_account", operationId: "getAccount", kind: "read", title: "Account settings",
    description: "The account's default timezone, default locale and the locales events can be translated into. Read it before creating an event: titles are needed in the default locale, and times are in the account's timezone unless the event says otherwise.",
  },
  {
    name: "list_events", operationId: "listEvents", kind: "read", title: "Find events",
    description: "Events, newest first, with their next start and number of occurrences. `q` matches the slug or any title; filter by status, tag, location or a time window. Use it to find an event the human refers to by name, and to check whether a similar event already exists before creating one. Pass `nextCursor` back as `cursor` for more.",
  },
  {
    name: "get_event", operationId: "getEvent", kind: "read", id: "eventId", title: "Get an event",
    description: "One event: titles and descriptions per locale, status, timezone, default location and duration, admission mode, registration settings, tags, access groups and `version`. For its schedule, offers and rules too, use get_event_configuration.",
  },
  {
    name: "list_occurrences", operationId: "listEventOccurrences", kind: "read", id: "eventId", title: "List occurrences",
    description: "The event's occurrences (dates) in start order, each with its effective values and where they come from (default, rule or override), and places for registration events. Filter by a time window or series; pass `nextCursor` back as `cursor` for more.",
  },
  {
    name: "list_series", operationId: "listEventSeries", kind: "read", id: "eventId", title: "List recurring series",
    description: "The event's recurring series: RRULE, first local start, duration, timezone and removed dates.",
  },
  {
    name: "list_offers", operationId: "listEventOffers", kind: "read", id: "eventId", title: "List ticket types",
    description: "The offers (ticket types) of a ticketed event, with default price, VAT class, limits, sales windows, channels, group prices and access groups.",
  },
  {
    name: "list_rules", operationId: "listEventRules", kind: "read", id: "eventId", title: "List rules",
    description: "The event's rules in resolution order: conditions (weekdays, dates, times) and effects (capacity, prices, availability of offers).",
  },
  {
    name: "list_locations", operationId: "listLocations", kind: "read", title: "List locations",
    description: "The account's venues and the spaces inside them, flat; a space's `parentId` is its venue. Use the id as an event's defaultLocationId or an occurrence's locationOverrideId.",
  },
  {
    name: "list_tags", operationId: "listTagVocabularies", kind: "read", title: "List tags",
    description: "Tag vocabularies (e.g. audience, category) with their tags. Use tag ids in an event's tagIds.",
  },
  {
    name: "list_user_groups", operationId: "listUserGroups", kind: "read", title: "List user groups",
    description: "The account's user groups (e.g. members). Use their ids in accessGroupIds to restrict an event or offer, and in an offer's groupPrices.",
  },
  {
    name: "list_vat_classes", operationId: "listVatClasses", kind: "read", title: "List VAT classes",
    description: "The account's VAT classes. Every offer needs one; prices are in minor units including VAT.",
  },

  // ── Events ───────────────────────────────────────────────────────────────────
  {
    name: "create_event", operationId: "createEvent", kind: "write", title: "Create a draft event",
    description: "Creates an event as a draft, not visible to the public until published. Needs a title in at least one locale. Dates are added afterwards with create_series or create_occurrence; ticket types with create_offer. Pass an `idempotencyKey` so a retried call does not create a second event.",
  },
  {
    name: "update_event", operationId: "updateEvent", kind: "write", id: "eventId", ifMatch: true, destructive: true, idempotent: true, title: "Change an event",
    description: `Changes an event's details or configuration; only the fields given change. A translation given replaces that locale's translation, null removes it. tagIds and accessGroupIds replace the lists; registration merges per field.${VERSION_NOTE}`,
  },
  {
    name: "publish_event", operationId: "publishEvent", kind: "write", id: "eventId", ifMatch: true, destructive: true, title: "Publish an event",
    description: `Makes a draft or cancelled event public: it appears in the public API and on the client's website. Only after the human has reviewed the event and said to publish.${VERSION_NOTE}`,
  },
  {
    name: "unpublish_event", operationId: "unpublishEvent", kind: "write", id: "eventId", ifMatch: true, destructive: true, title: "Unpublish an event",
    description: `Puts a published event back to draft, hiding it from the public API.${VERSION_NOTE}`,
  },
  {
    name: "cancel_event", operationId: "cancelEvent", kind: "write", id: "eventId", ifMatch: true, destructive: true, title: "Cancel an event",
    description: `Marks the event cancelled. It stays public so websites can say so. Only on the human's explicit instruction.${VERSION_NOTE}`,
  },

  // ── Schedule ─────────────────────────────────────────────────────────────────
  {
    name: "create_series", operationId: "createSeries", kind: "write", id: "eventId", title: "Add a recurring series",
    description: "Adds recurring dates from an RFC 5545 RRULE and a first local start (wall time in the series' timezone, no offset). Call with dryRun=true first to see the dates it would create and show them to the human; then call again without it.",
  },
  {
    name: "update_series", operationId: "updateSeries", kind: "write", id: "seriesId", ifMatch: true, destructive: true, title: "Change a recurring series",
    description: `Changes a series' rule, start, duration or timezone; its future occurrences are moved, added or removed. Call with dryRun=true first and show the changes, especially removed dates that may have registrations or tickets.${VERSION_NOTE}`,
  },
  {
    name: "create_occurrence", operationId: "createOccurrence", kind: "write", id: "eventId", title: "Add a single date",
    description: "Adds a one-off occurrence. startUtc and endUtc are UTC instants (with Z or an offset); endUtc defaults to start plus the event's default duration. Overrides (location, capacity, tags, external link) apply to this date only.",
  },
  {
    name: "update_occurrence", operationId: "updateOccurrence", kind: "write", id: "occurrenceId", ifMatch: true, destructive: true, idempotent: true, title: "Change a single date",
    description: `Moves, cancels or overrides one occurrence. Changing its time or overrides detaches it from its series.${VERSION_NOTE}`,
  },

  // ── Ticketing ────────────────────────────────────────────────────────────────
  {
    name: "create_offer", operationId: "createOffer", kind: "write", id: "eventId", title: "Add a ticket type",
    description: "Adds an offer (ticket type, e.g. Adult, Child) to an event whose admissionMode is tickets. Needs a code, a VAT class, a default price in minor units including VAT (e.g. 15000 for NOK 150) and a name per locale. Pass an `idempotencyKey` so a retry does not add it twice.",
  },
  {
    name: "update_offer", operationId: "updateOffer", kind: "write", id: "offerId", ifMatch: true, destructive: true, idempotent: true, title: "Change a ticket type",
    description: `Changes an offer's price, limits, sales window, channels, group prices or names, or sets its status. A new default price is resolved for every occurrence.${VERSION_NOTE}`,
  },
  {
    name: "create_rule", operationId: "createRule", kind: "write", id: "eventId", title: "Add a rule",
    description: "Adds a rule that changes capacity, prices or offer availability on matching occurrences (e.g. weekends, a date range, evenings). Call with dryRun=true first and show the human which dates change; then call again without it.",
  },
  {
    name: "update_rule", operationId: "updateRule", kind: "write", id: "ruleId", ifMatch: true, destructive: true, title: "Change a rule",
    description: `Changes a rule's name, priority, conditions or effects, or turns it off. Call with dryRun=true first and show what changes.${VERSION_NOTE}`,
  },

  // ── Supporting data ──────────────────────────────────────────────────────────
  {
    name: "create_location", operationId: "createLocation", kind: "write", title: "Add a location",
    description: "Adds a venue, or a space inside a venue (give the venue as parentId). Check list_locations first: the place may already exist under another name.",
  },
];
