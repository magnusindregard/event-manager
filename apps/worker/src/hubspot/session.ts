import type { Db } from "@event-manager/db";
import { integrations } from "@event-manager/domain";
import { type HubSpotClient, hubspotAuth } from "@event-manager/hubspot";

/**
 * Runs `fn` with the account's active HubSpot connection and a current access token; null when
 * there is none to use (see `integrations.withProvider`).
 */
export function withHubSpot<T>(
  db: Db,
  tenantId: string,
  client: HubSpotClient,
  fn: (accessToken: string, connection: integrations.Connection) => Promise<T>,
  now = () => new Date(),
): Promise<{ value: T } | null> {
  return integrations.withProvider(db, tenantId, "hubspot", hubspotAuth(client), fn, now);
}
