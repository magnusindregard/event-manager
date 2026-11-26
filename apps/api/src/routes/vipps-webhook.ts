import type { FastifyPluginAsync } from "fastify";
import { withTenant } from "@event-manager/db";
import { payments } from "@event-manager/domain";
import { HttpProblem } from "../plugins/problem.js";

// Vipps ePayment webhooks (docs/checkout.md, "Connecting Vipps MobilePay"). Each provider
// account registers its own webhook, at /webhooks/vipps/{tenant}/{provider account}, so the
// request names the tenant to open and the secret to check it with. Vipps signs the request
// with HMAC-SHA256 over the method, path, date, host and the body's hash (packages/vipps,
// webhook.ts); the check needs the body exactly as sent, so this plugin reads it as text.
//
// The webhook only says that something happened. It queues payments.process for the payment
// and answers 200 at once; the worker reads Vipps for the truth. Unknown references are
// acknowledged too, so Vipps does not retry events for payments made outside the platform.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checks a webhook request's signature; packages/vipps' verifyWebhook in production, injectable for tests. */
export type WebhookVerifier = (secret: string, req: { method: string; pathAndQuery: string; host: string; date: string; contentSha256: string; authorization: string; body: string }) => boolean;

export const vippsWebhookRoutes: FastifyPluginAsync<{ verify: WebhookVerifier; publicHost?: string | null }> = async (app, opts) => {
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 65_536 }, (_req, body, done) => done(null, body));

  app.post<{ Params: { tenantId: string; accountId: string } }>(
    "/webhooks/vipps/:tenantId/:accountId",
    { schema: { hide: true } },
    async (req, reply) => {
      const { tenantId, accountId } = req.params;
      if (!UUID.test(tenantId) || !UUID.test(accountId)) throw new HttpProblem(404, "not_found", "Unknown webhook");
      const body = typeof req.body === "string" ? req.body : "";
      const header = (name: string) => {
        const v = req.headers[name];
        return Array.isArray(v) ? v[0] ?? "" : v ?? "";
      };

      const outcome = await withTenant(app.db, { tenantId }, async (tx) => {
        const secret = await payments.webhookSecretFor(tx, tenantId, accountId);
        if (!secret) return "unknown" as const;
        const signed = opts.verify(secret, {
          // Vipps signs the host it called; behind Front Door the request carries the origin host instead.
          method: req.method, pathAndQuery: req.url, host: opts.publicHost ?? header("host"), date: header("x-ms-date"),
          contentSha256: header("x-ms-content-sha256"), authorization: header("authorization"), body,
        });
        if (!signed) return "unsigned" as const;
        let reference: unknown;
        try {
          reference = (JSON.parse(body) as { reference?: unknown }).reference;
        } catch {
          return "ignored" as const;
        }
        if (typeof reference !== "string") return "ignored" as const;
        const paymentId = await payments.paymentByReference(tx, reference);
        if (!paymentId) return "ignored" as const;
        await payments.queueProcessing(tx, tenantId, paymentId);
        return "queued" as const;
      });

      if (outcome === "unknown") throw new HttpProblem(404, "not_found", "Unknown webhook");
      if (outcome === "unsigned") throw new HttpProblem(401, "unauthenticated", "The webhook signature does not match");
      return reply.status(200).send({ ok: true, ...(outcome === "ignored" ? { ignored: true } : {}) });
    },
  );
};
