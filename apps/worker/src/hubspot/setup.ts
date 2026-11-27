import type { Task } from "graphile-worker";
import { type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { integrations } from "@event-manager/domain";
import { type HubSpotClient, HubSpotError } from "@event-manager/hubspot";
import type { InternalHandler } from "../handlers.js";
import { setUpCleanup } from "./cleanup.js";
import { readSingleSendEmails } from "./emails.js";
import { withHubSpot } from "./session.js";

export interface HubSpotDeps {
  client: HubSpotClient;
  /** Base of the hosted attendee pages, for the links in the event's HubSpot emails. */
  attendeeUrl?: string;
  /** How long to wait between reads of a send's status (tests pass 0). */
  pollMs?: number;
}

export const HUBSPOT_SETUP_TASK = "hubspot.setup";

/** A connection was made or an owner asked for "Repair setup": one keyed job per connection. */
export const queueHubSpotSetup: InternalHandler = {
  name: "queue-hubspot-setup",
  types: ["integration.connected.v1", "integration.setup_requested.v1"],
  async handle(tx, event) {
    const { connectionId, provider } = event.data as { connectionId?: string; provider?: string };
    if (!connectionId || provider !== "hubspot") return;
    await sql`select graphile_worker.add_job(
      ${HUBSPOT_SETUP_TASK},
      json_build_object('tenantId', ${event.tenantId}::text, 'connectionId', ${connectionId}::text),
      job_key := ${`hubspot-setup:${connectionId}`},
      max_attempts := 8)`.execute(tx);
  },
};

interface Payload {
  tenantId: string;
  connectionId: string;
}
const isPayload = (p: unknown): p is Payload =>
  typeof p === "object" && p !== null && typeof (p as Payload).tenantId === "string" && typeof (p as Payload).connectionId === "string";

/**
 * Sets the portal up for the connector (docs/hubspot.md, "Setup in the portal"): checks that our
 * token reaches the portal we connected, then, with the cleanup scopes, reads the subscription
 * types and makes the cleanup segments and workflow (milestone 4). Custom event definitions
 * (milestone 7) join here. Idempotent. Rate limits and HubSpot
 * outages retry; other refusals are recorded on the connection for the admin and not retried
 * until an owner repairs.
 */
export function hubspotSetupTask(db: Db, deps: HubSpotDeps | null): Task {
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${HUBSPOT_SETUP_TASK} payload`);
    if (!deps) {
      helpers.logger.warn("HubSpot is not configured (HUBSPOT_CLIENT_ID); setup skipped");
      return;
    }
    // The generation that ran the setup; its result is recorded on that generation only.
    let ref: integrations.ConnectionRef | null = null;
    const record = (result: { ok: true } | { ok: false; error: string }) =>
      ref ? withTenant(db, { tenantId: payload.tenantId }, (tx) => integrations.recordSetup(tx, ref!, result)) : Promise.resolve();
    try {
      const done = await withHubSpot(db, payload.tenantId, deps.client, async (accessToken, connection) => {
        if (connection.id !== payload.connectionId) return null;
        ref = { id: connection.id, generation: connection.generation };
        const details = await deps.client.accountDetails(accessToken);
        if (details.portalId !== connection.portalId) throw new HubSpotError(`HubSpot answered for portal ${details.portalId}, not the connected portal ${connection.portalId}`, 409);
        const t = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, { tenantId: payload.tenantId }, fn);
        // A sandbox or test portal sends marketing email only to its own users (seen on staging): the admin warns.
        await t((tx) => integrations.recordPortalSetup(tx, ref!, { portalId: connection.portalId, accountType: details.accountType }));
        await setUpCleanup(deps.client, accessToken, connection, t);
        await readSingleSendEmails(deps.client, accessToken, connection, t);
        return connection.portalId;
      });
      if (!done?.value) return;
      await record({ ok: true });
      helpers.logger.info(`hubspot setup done for portal ${done.value}`);
    } catch (e) {
      if (!(e instanceof HubSpotError)) throw e;
      await record({ ok: false, error: e.message });
      if (e.retryable) throw e;
      helpers.logger.error(`hubspot setup failed for connection ${payload.connectionId}: ${e.message}`);
    }
  };
}
