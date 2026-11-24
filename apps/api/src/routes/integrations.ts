import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { DomainError, integrations, tenancy } from "@event-manager/domain";
import { BEHAVIOURAL_EVENT_SCOPES, type HubSpotClient, HubSpotError, OPTIONAL_SCOPES, REQUIRED_SCOPES, signState, verifyState } from "@event-manager/hubspot";
import { HubSpotAuthorize, HubSpotCallback, Integration, IntegrationList, IntegrationSettingsPatch, IntegrationSync, IntegrationSyncRetry, Problem } from "@event-manager/schemas";
import { inTenant } from "../plugins/context.js";
import { expectedVersion, setEtag } from "../plugins/etag.js";

// Integrations (docs/hubspot.md, ADR 0017). Connecting is OAuth with our own HubSpot app:
//   1. POST /integrations/hubspot/authorize gives the install URL, with a signed state naming
//      the account and the owner who started.
//   2. HubSpot sends the browser back to the admin's callback page, which posts code and state
//      here with the owner's own token. The state must be for this account and this user, so a
//      link someone else started cannot connect their portal to your account (or yours to theirs).
//   3. We exchange the code, read the portal and scopes, store the tokens encrypted; the worker
//      sets up the portal.

export interface HubSpotDeps {
  client: HubSpotClient;
  clientSecret: string;
}

const accountScoped = { security: [{ bearer: [], accountId: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };
const writeErrors = { ...errors, 409: Problem, 412: Problem, 422: Problem, 428: Problem };

const dto = (c: integrations.Connection) => ({
  id: c.id,
  provider: c.provider,
  status: c.status,
  statusReason: c.statusReason,
  portalId: c.portalId,
  scopes: c.scopes,
  features: { customEvents: BEHAVIOURAL_EVENT_SCOPES.every((s) => c.scopes.includes(s)) },
  settings: c.settings,
  setup: { status: c.setup.status, error: c.setup.error, at: c.setup.at?.toISOString() ?? null },
  connectedAt: c.connectedAt.toISOString(),
  disconnectedAt: c.disconnectedAt?.toISOString() ?? null,
  version: c.version,
  updatedAt: c.updatedAt.toISOString(),
});

export const integrationRoutes: FastifyPluginAsyncTypebox<{ hubspot: HubSpotDeps | null }> = async (app, opts) => {
  app.addHook("preHandler", app.requireAccount);
  const hubspot = () => {
    if (!opts.hubspot) throw new DomainError("conflict", "HubSpot is not set up on this platform");
    return opts.hubspot;
  };
  /** Revokes at HubSpot after our own change is committed; a failure only leaves a token HubSpot will expire. */
  const revoke = async (refreshToken: string | null) => {
    if (!refreshToken || !opts.hubspot) return;
    await opts.hubspot.client.revoke(refreshToken).catch((e: unknown) => app.log.warn({ err: e }, "revoking the HubSpot token failed"));
  };

  app.get(
    "/integrations",
    { schema: { operationId: "listIntegrations", tags: ["integrations"], ...accountScoped, summary: "The account's connections to outside systems", response: { 200: IntegrationList, ...errors } } },
    async (req) => ({
      items: (await inTenant(app, req, (tx, ctx) => integrations.listConnections(tx, ctx))).map(dto),
      available: { hubspot: opts.hubspot !== null },
    }),
  );

  app.post(
    "/integrations/hubspot/authorize",
    { schema: { operationId: "authorizeHubSpot", tags: ["integrations"], ...accountScoped, summary: "Owner only. Starts connecting a HubSpot portal: returns the install URL", response: { 200: HubSpotAuthorize, ...writeErrors } } },
    async (req, reply) => {
      const { client, clientSecret } = hubspot();
      const ctx = req.actor!;
      tenancy.assertCan(ctx, "account.write");
      const state = signState(clientSecret, { tenantId: ctx.tenantId, userId: ctx.userId! });
      return reply.header("cache-control", "no-store").send({ url: client.authorizeUrl(state, { required: REQUIRED_SCOPES, optional: OPTIONAL_SCOPES }) });
    },
  );

  app.post(
    "/integrations/hubspot/callback",
    { schema: { operationId: "completeHubSpotConnection", tags: ["integrations"], ...accountScoped, summary: "Owner only. Finishes connecting with the code and state HubSpot sent back", body: HubSpotCallback, response: { 200: Integration, ...writeErrors } } },
    async (req, reply) => {
      const { client, clientSecret } = hubspot();
      const ctx = req.actor!;
      tenancy.assertCan(ctx, "account.write");
      const state = verifyState(clientSecret, req.body.state);
      if (!state) throw new DomainError("validation_failed", "The link has expired or is not valid. Start connecting again", { field: "state" });
      if (state.tenantId !== ctx.tenantId || state.userId !== ctx.userId) throw new DomainError("forbidden", "Connecting was started by someone else or for another account");

      let tokens, info;
      try {
        tokens = await client.exchangeCode(req.body.code);
        info = await client.tokenInfo(tokens.accessToken);
      } catch (e) {
        if (e instanceof HubSpotError && e.status >= 400 && e.status < 500) throw new DomainError("validation_failed", "HubSpot did not accept the code. Start connecting again", { field: "code" });
        throw e;
      }
      let c: integrations.Connection;
      try {
        c = await inTenant(app, req, (tx, actor) =>
          integrations.saveConnection(tx, actor, {
            provider: "hubspot",
            portalId: info.portalId,
            scopes: info.scopes,
            tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: tokens.expiresAt },
            requiredScopes: REQUIRED_SCOPES,
          }),
        );
      } catch (e) {
        // Not stored, so uninstall again rather than leave the app installed with nobody using it.
        await revoke(tokens.refreshToken);
        throw e;
      }
      setEtag(reply, c.version);
      return dto(c);
    },
  );

  app.patch(
    "/integrations/hubspot",
    { schema: { operationId: "updateHubSpotIntegration", tags: ["integrations"], ...accountScoped, summary: "Owner only. Who to sync to HubSpot. Requires If-Match", body: IntegrationSettingsPatch, response: { 200: Integration, ...writeErrors } } },
    async (req, reply) => {
      const v = expectedVersion(req);
      const c = await inTenant(app, req, (tx, ctx) => integrations.updateSettings(tx, ctx, "hubspot", v, req.body));
      setEtag(reply, c.version);
      return dto(c);
    },
  );

  app.post(
    "/integrations/hubspot/setup",
    { schema: { operationId: "repairHubSpotSetup", tags: ["integrations"], ...accountScoped, summary: "Owner only. Runs the setup in the portal again", response: { 202: Integration, ...writeErrors } } },
    async (req, reply) => {
      const c = await inTenant(app, req, (tx, ctx) => integrations.requestSetup(tx, ctx, "hubspot"));
      return reply.status(202).send(dto(c));
    },
  );

  app.get(
    "/integrations/hubspot/sync",
    { schema: { operationId: "getHubSpotSync", tags: ["integrations"], ...accountScoped, summary: "The sync log: what is in step with HubSpot, waiting or refused, and why", response: { 200: IntegrationSync, ...errors } } },
    async (req) => {
      const s = await inTenant(app, req, (tx, ctx) => integrations.syncSummary(tx, ctx, "hubspot"));
      return {
        counts: s.counts,
        lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
        issues: s.issues.map((i) => ({ ...i, startUtc: i.startUtc?.toISOString() ?? null, updatedAt: i.updatedAt.toISOString() })),
      };
    },
  );

  app.post(
    "/integrations/hubspot/sync/retry",
    { schema: { operationId: "retryHubSpotSync", tags: ["integrations"], ...accountScoped, summary: "Owner only. Tries every item HubSpot refused again", response: { 202: IntegrationSyncRetry, ...writeErrors } } },
    async (req, reply) => {
      const retried = await inTenant(app, req, (tx, ctx) => integrations.retryFailed(tx, ctx, "hubspot"));
      return reply.status(202).send({ retried });
    },
  );

  app.post(
    "/integrations/hubspot/resync",
    { schema: { operationId: "resyncHubSpot", tags: ["integrations"], ...accountScoped, summary: "Owner only. Pushes everything the connection should show again, as after connecting", response: { 202: Type.Null(), ...writeErrors } } },
    async (req, reply) => {
      await inTenant(app, req, (tx, ctx) => integrations.requestResync(tx, ctx, "hubspot"));
      return reply.status(202).send(null);
    },
  );

  app.delete(
    "/integrations/hubspot",
    { schema: { operationId: "disconnectHubSpot", tags: ["integrations"], ...accountScoped, summary: "Owner only. Stops all sync and deletes our tokens; what was written to HubSpot stays there", response: { 204: Type.Null(), ...writeErrors } } },
    async (req, reply) => {
      const { refreshToken } = await inTenant(app, req, (tx, ctx) => integrations.disconnect(tx, ctx, "hubspot"));
      await revoke(refreshToken);
      return reply.status(204).send(null);
    },
  );
};
