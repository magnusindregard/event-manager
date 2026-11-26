import { type Db, type IntegrationProvider, withTenant } from "@event-manager/db";
import { type Connection, loadForSync, markNeedsReconnect, storeRefreshedTokens } from "./index.js";

/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** How a provider's client refreshes tokens and says it refused one. */
export interface ProviderAuth {
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }>;
  /** The provider refused the refresh token itself (uninstalled, revoked): only an owner can fix it. */
  refusedRefresh(e: unknown): boolean;
  /** The provider refused an access token: worth one refresh and a second try. */
  refusedAccess(e: unknown): boolean;
}

/**
 * Runs `fn` with the account's active connection and a current access token, for the worker and
 * the API alike. Returns null, without calling `fn`, when there is nothing to use: not
 * connected, disconnected, or waiting for a reconnect.
 *
 * The token is refreshed first when it is about to expire, and once more if the provider refuses
 * it anyway (early expiry, clock skew). Only a refused refresh marks the connection
 * needs_reconnect. Every write back names the generation loaded here, so a caller that outlives a
 * disconnect and reconnect leaves the new install alone, and gets null. Two refreshes at once are
 * harmless; HubSpot keeps the refresh token.
 */
export async function withProvider<T>(
  db: Db,
  tenantId: string,
  provider: IntegrationProvider,
  auth: ProviderAuth,
  fn: (accessToken: string, connection: Connection) => Promise<T>,
  now = () => new Date(),
): Promise<{ value: T } | null> {
  const scope = { tenantId };
  const loaded = await withTenant(db, scope, (tx) => loadForSync(tx, tenantId, provider));
  if (!loaded) return null;
  const { connection, tokens } = loaded;

  const refresh = async (): Promise<string | null> => {
    try {
      const fresh = await auth.refresh(tokens.refreshToken);
      const stored = await withTenant(db, scope, (tx) =>
        storeRefreshedTokens(tx, tenantId, connection, { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken || tokens.refreshToken, accessExpiresAt: fresh.expiresAt }),
      );
      // Disconnected or reconnected (perhaps to another portal) meanwhile: these tokens belong
      // to an install that is gone, so stop rather than act on it.
      return stored ? fresh.accessToken : null;
    } catch (e) {
      if (auth.refusedRefresh(e)) {
        await withTenant(db, scope, (tx) => markNeedsReconnect(tx, tenantId, connection, e instanceof Error ? e.message : String(e)));
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
    if (!auth.refusedAccess(e) || refreshed) throw e;
    accessToken = await refresh();
    if (!accessToken) return null;
    return { value: await fn(accessToken, connection) };
  }
}
