import { type Db, withTenant } from "@event-manager/db";
import { integrations } from "@event-manager/domain";
import { type HubSpotClient, HubSpotError } from "@event-manager/hubspot";

/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Runs `fn` with the account's active HubSpot connection and a current access token. Returns
 * null, without calling `fn`, when there is nothing to use: not connected, disconnected, or
 * waiting for a reconnect.
 *
 * The token is refreshed first when it is about to expire, and once more if HubSpot refuses it
 * anyway (early expiry, clock skew). Only a refresh HubSpot refuses (app uninstalled, access
 * revoked) marks the connection needs_reconnect: nothing to retry until an owner connects again.
 * Every write back names the generation loaded here, so a job that outlives a disconnect and
 * reconnect leaves the new install alone, and returns null.
 * Two jobs refreshing at once is harmless; HubSpot keeps the refresh token.
 */
export async function withHubSpot<T>(
  db: Db,
  tenantId: string,
  client: HubSpotClient,
  fn: (accessToken: string, connection: integrations.Connection) => Promise<T>,
  now = () => new Date(),
): Promise<{ value: T } | null> {
  const scope = { tenantId };
  const loaded = await withTenant(db, scope, (tx) => integrations.loadForSync(tx, tenantId, "hubspot"));
  if (!loaded) return null;
  const { connection, tokens } = loaded;

  const refresh = async (): Promise<string | null> => {
    try {
      const fresh = await client.refresh(tokens.refreshToken);
      const stored = await withTenant(db, scope, (tx) =>
        integrations.storeRefreshedTokens(tx, tenantId, connection, { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken || tokens.refreshToken, accessExpiresAt: fresh.expiresAt }),
      );
      // Disconnected or reconnected (perhaps to another portal) meanwhile: these tokens belong
      // to an install that is gone, so this job stops rather than act on it.
      return stored ? fresh.accessToken : null;
    } catch (e) {
      // HubSpot answers 400 to a refresh token it no longer accepts.
      if (e instanceof HubSpotError && (e.unauthorized || e.status === 400)) {
        await withTenant(db, scope, (tx) => integrations.markNeedsReconnect(tx, tenantId, connection, e.message));
        return null;
      }
      throw e;
    }
  };

  let accessToken: string | null = tokens.accessToken;
  let refreshed = false;
  if (tokens.accessExpiresAt.getTime() - now().getTime() <= REFRESH_MARGIN_MS) {
    accessToken = await refresh();
    refreshed = true;
    if (!accessToken) return null;
  }
  try {
    return { value: await fn(accessToken, connection) };
  } catch (e) {
    if (!(e instanceof HubSpotError) || !e.unauthorized || refreshed) throw e;
    accessToken = await refresh();
    if (!accessToken) return null;
    return { value: await fn(accessToken, connection) };
  }
}
