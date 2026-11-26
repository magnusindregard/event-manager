import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { DomainError, offers, payments } from "@event-manager/domain";
import { HostedCheckout, PaymentsSettings, Problem, VippsConnect, VippsConnection } from "@event-manager/schemas";
import { inTenant } from "../plugins/context.js";
import { expectedVersion, setEtag } from "../plugins/etag.js";

// Payments settings (docs/checkout.md, ADR 0018). Each account connects its own Vipps
// MobilePay merchant: the platform initiates payments on the client's behalf and never holds
// money. Everyone in the account can see the connection; owners connect, verify and disconnect.
// The keys are write-only: they go in, are checked with Vipps, and are never shown again.

export interface PaymentsDeps {
  provider: payments.PaymentProvider;
  /** The API's public base URL, for the webhook Vipps calls; null registers none (local stacks poll). */
  webhookBaseUrl: string | null;
}

const accountScoped = { security: [{ bearer: [], accountId: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };
const writeErrors = { ...errors, 409: Problem, 412: Problem, 422: Problem, 428: Problem };

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const dto = (a: payments.ProviderAccount) => ({
  id: a.id, provider: a.provider, environment: a.environment, merchantSerialNumber: a.merchantSerialNumber, clientId: a.clientId,
  status: a.status, statusReason: a.statusReason, webhookRegistered: a.webhookRegistered, verifiedAt: iso(a.verifiedAt),
  connectedAt: a.connectedAt.toISOString(), version: a.version, updatedAt: a.updatedAt.toISOString(),
});

/** Where Vipps posts payment events for one provider account (routes/vipps-webhook.ts). */
export const webhookPath = (tenantId: string, providerAccountId: string) => `/webhooks/vipps/${tenantId}/${providerAccountId}`;

export const paymentRoutes: FastifyPluginAsyncTypebox<{ payments: PaymentsDeps | null }> = async (app, opts) => {
  app.addHook("preHandler", app.requireAccount);
  const deps = (): payments.ProviderDeps => {
    if (!opts.payments) throw new DomainError("conflict", "Payments are not set up on this platform");
    const base = opts.payments.webhookBaseUrl?.replace(/\/$/, "") ?? null;
    return { provider: opts.payments.provider, webhookUrl: base ? (t, id) => `${base}${webhookPath(t, id)}` : null };
  };

  app.get(
    "/payments",
    { schema: { operationId: "getPaymentsSettings", tags: ["payments"], ...accountScoped, summary: "The account's payment provider (Vipps MobilePay), if connected", response: { 200: PaymentsSettings, ...errors } } },
    async (req) =>
      inTenant(app, req, async (tx) => {
        const [a, channel] = await Promise.all([payments.getProviderAccount(tx), offers.hostedChannel(tx)]);
        return { vipps: a ? dto(a) : null, checkout: channel ? { channelId: channel.id, active: channel.active } : null };
      }),
  );

  app.post(
    "/payments/checkout",
    {
      schema: {
        operationId: "enableHostedCheckout", tags: ["payments"], ...accountScoped,
        summary: "Enable the hosted checkout (owner): creates its sales channel, which emails tickets, or activates it again. VAT classes without a SKU there get TICKET-<code>.",
        response: { 200: HostedCheckout, ...writeErrors },
      },
    },
    async (req) => {
      const c = await inTenant(app, req, (tx, ctx) => offers.enableHostedChannel(tx, ctx));
      return { channelId: c.id, active: c.active };
    },
  );

  app.put(
    "/payments/vipps",
    {
      schema: {
        operationId: "connectVipps", tags: ["payments"], ...accountScoped,
        summary: "Connect the account's Vipps MobilePay merchant (owner). The keys are checked with Vipps first; a merchant already connected is replaced.",
        body: VippsConnect, response: { 200: VippsConnection, ...writeErrors },
      },
    },
    async (req, reply) => {
      const a = await payments.connectVipps(app.db, req.actor!, req.body, deps());
      setEtag(reply, a.version);
      return dto(a);
    },
  );

  app.post(
    "/payments/vipps/verify",
    {
      schema: {
        operationId: "verifyVipps", tags: ["payments"], ...accountScoped,
        summary: "Check the stored keys with Vipps again and register the webhook if it is missing (owner)",
        response: { 200: VippsConnection, ...writeErrors },
      },
    },
    async (req, reply) => {
      const a = await payments.verifyVipps(app.db, req.actor!, deps());
      setEtag(reply, a.version);
      return dto(a);
    },
  );

  app.delete(
    "/payments/vipps",
    {
      schema: {
        operationId: "disconnectVipps", tags: ["payments"], ...accountScoped,
        summary: "Disconnect Vipps MobilePay (owner): deletes the keys and the webhook. Payments already made stay. Requires If-Match.",
        response: { 204: Type.Null(), ...writeErrors },
      },
    },
    async (req, reply) => {
      await payments.disconnectVipps(app.db, req.actor!, expectedVersion(req), deps());
      return reply.status(204).send(null);
    },
  );
};
