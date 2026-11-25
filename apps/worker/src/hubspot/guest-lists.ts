import type { Task } from "graphile-worker";
import { type Db, sql, withTenant } from "@event-manager/db";
import { integrations, registration, tenancy } from "@event-manager/domain";
import { HubSpotError } from "@event-manager/hubspot";
import type { InternalHandler } from "../handlers.js";
import { withHubSpot } from "./session.js";
import type { HubSpotDeps } from "./setup.js";

// A guest list from a HubSpot list (docs/hubspot.md, milestone 6): reads the list's members
// (email, name, language, record id) and stages them in the guest import, where staff map,
// preview and commit as for a file. The record id goes in as the guest's contact id.

export const HUBSPOT_GUEST_LIST_TASK = "hubspot.guest_list";

/** The columns of a list staged from HubSpot; the import's header guesses map them by themselves. */
export const LIST_HEADERS = ["Email", "First name", "Last name", "Language", "Contact ID"];
const PROPERTIES = ["email", "firstname", "lastname", "hs_language"];

/** Pure: HubSpot's language (`nb`, `no`, `en-us`, …) as one of the account's locales, or empty. */
export function localeFromHubSpot(value: string | null | undefined, locales: readonly string[]): string {
  const v = (value ?? "").trim().toLowerCase().replace("_", "-");
  if (!v) return "";
  const base = v.split("-")[0]!;
  for (const l of [v, base, base === "no" || base === "nn" ? "nb" : ""]) if (l && locales.includes(l)) return l;
  return "";
}

export const queueHubSpotGuestList: InternalHandler = {
  name: "queue-hubspot-guest-list",
  types: ["integration.guest_list_requested.v1"],
  async handle(tx, event) {
    const eventId = (event.data as { eventId?: unknown }).eventId;
    if (typeof eventId !== "string") return;
    await sql`select graphile_worker.add_job(
      ${HUBSPOT_GUEST_LIST_TASK},
      json_build_object('tenantId', ${event.tenantId}::text, 'eventId', ${eventId}::text),
      job_key := ${`hubspot-guest-list:${eventId}`},
      max_attempts := 6)`.execute(tx);
  },
};

interface Payload {
  tenantId: string;
  eventId: string;
}
const isPayload = (p: unknown): p is Payload => typeof p === "object" && p !== null && typeof (p as Payload).tenantId === "string" && typeof (p as Payload).eventId === "string";

/** Fetches and stages the event's requested HubSpot list. Returns the staged import, or null when there was nothing to do. */
export async function fetchGuestList(db: Db, tenantId: string, eventId: string, deps: HubSpotDeps, lastAttempt = true): Promise<string | null> {
  const t = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, { tenantId }, fn);
  const pending = await t((tx) => integrations.pendingGuestList(tx, eventId));
  if (!pending) return null;
  const fail = (error: string) => t((tx) => integrations.recordGuestListFailed(tx, eventId, pending.requestedAt, error));
  try {
    const run = await withHubSpot(db, tenantId, deps.client, async (accessToken, connection) => {
      const client = deps.client;
      const list = await client.getList(accessToken, pending.listId);
      if (!list) {
        await fail("HubSpot has no such list any more");
        return null;
      }
      const ids = await client.listMembers(accessToken, pending.listId);
      if (ids.length > registration.MAX_IMPORT_ROWS) {
        await fail(`The list has ${ids.length} members; at most ${registration.MAX_IMPORT_ROWS} can be imported`);
        return null;
      }
      const locales = (await t((tx) => tenancy.getAccount(tx))).locales;
      const rows: string[][] = [];
      for (let i = 0; i < ids.length; i += 100) {
        for (const c of await client.readContacts(accessToken, ids.slice(i, i + 100), PROPERTIES)) {
          const p = c.properties;
          rows.push([p.email ?? "", p.firstname ?? "", p.lastname ?? "", localeFromHubSpot(p.hs_language, locales), c.id]);
        }
      }
      return t(async (tx) => {
        const draft = await registration.stageRows(tx, tenantId, eventId, pending.requestedBy, `HubSpot: ${list.name}`, { headers: LIST_HEADERS, rows });
        const kept = await integrations.recordGuestListFetched(tx, { id: connection.id, generation: connection.generation }, eventId, pending.requestedAt, { importId: draft.id, listName: list.name, memberCount: rows.length });
        return kept ? draft.id : null;
      });
    });
    if (!run) {
      await fail("HubSpot is not connected, or refuses our access");
      return null;
    }
    return run.value;
  } catch (e) {
    // Rate limits and outages are tried again; anything else, or the last attempt, is told to staff.
    if (e instanceof HubSpotError && e.retryable && !lastAttempt) throw e;
    await fail(e instanceof Error ? e.message : String(e));
    if (!(e instanceof HubSpotError)) throw e;
    return null;
  }
}

export function hubspotGuestListTask(db: Db, deps: HubSpotDeps | null): Task {
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${HUBSPOT_GUEST_LIST_TASK} payload`);
    if (!deps) {
      await withTenant(db, { tenantId: payload.tenantId }, async (tx) => {
        const p = await integrations.pendingGuestList(tx, payload.eventId);
        if (p) await integrations.recordGuestListFailed(tx, payload.eventId, p.requestedAt, "HubSpot is not configured on this platform");
      });
      return;
    }
    const id = await fetchGuestList(db, payload.tenantId, payload.eventId, deps, helpers.job.attempts >= helpers.job.max_attempts);
    if (id) helpers.logger.info(`hubspot guest list staged for event ${payload.eventId} as import ${id}`);
  };
}
