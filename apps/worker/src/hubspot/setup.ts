import type { Task } from "graphile-worker";
import { type Db, sql, withTenant } from "@event-manager/db";
import { integrations } from "@event-manager/domain";
import { GUEST_KEY_PROPERTY, type HubSpotClient, HubSpotError, PROPERTY_GROUP } from "@event-manager/hubspot";
import type { InternalHandler } from "../handlers.js";
import { withHubSpot } from "./session.js";

export interface HubSpotDeps {
  client: HubSpotClient;
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
 * Creates what the connector needs in the portal (docs/hubspot.md, "Setup in the portal"):
 * the contact property group "Event manager" and the guest key property. Idempotent: what
 * exists is left alone. Rate limits and HubSpot outages retry; other refusals are recorded on
 * the connection for the admin and not retried until an owner repairs.
 */
export function hubspotSetupTask(db: Db, deps: HubSpotDeps | null): Task {
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${HUBSPOT_SETUP_TASK} payload`);
    if (!deps) {
      helpers.logger.warn("HubSpot is not configured (HUBSPOT_CLIENT_ID); setup skipped");
      return;
    }
    const record = (result: { ok: true } | { ok: false; error: string }) =>
      withTenant(db, { tenantId: payload.tenantId }, (tx) => integrations.recordSetup(tx, payload.connectionId, result));
    try {
      const done = await withHubSpot(db, payload.tenantId, deps.client, async (accessToken, connection) => {
        if (connection.id !== payload.connectionId) return null;
        await deps.client.ensureContactPropertyGroup(accessToken, PROPERTY_GROUP.name, PROPERTY_GROUP.label);
        await deps.client.ensureContactProperty(accessToken, GUEST_KEY_PROPERTY);
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
