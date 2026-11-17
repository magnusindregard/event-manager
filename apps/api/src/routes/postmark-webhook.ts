import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { withTenant } from "@event-manager/db";
import { registration } from "@event-manager/domain";
import { HttpProblem } from "../plugins/problem.js";

// Postmark delivery webhooks (Delivery, Bounce, SpamComplaint) for invitation emails
// (docs/registration.md, "Send log"). The worker sends each invitation with Metadata
// {tenantId, sendId}, which Postmark echoes here, so the report opens that tenant's
// transaction and touches only the send whose id and Postmark MessageID both match.
// Postmark authenticates with HTTP basic auth on the webhook URL.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Payload = Type.Object(
  {
    RecordType: Type.String(),
    MessageID: Type.Optional(Type.String()),
    Metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
    DeliveredAt: Type.Optional(Type.String()),
    BouncedAt: Type.Optional(Type.String()),
    Type: Type.Optional(Type.String()),
    Description: Type.Optional(Type.String()),
    Details: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const STATUS: Record<string, "delivered" | "bounced" | "spam_complaint"> = { Delivery: "delivered", Bounce: "bounced", SpamComplaint: "spam_complaint" };
// Soft bounces and auto-replies are not failures to deliver.
const NOT_BOUNCES = new Set(["Transient", "SoftBounce", "AutoResponder", "DnsError", "OpenRelayTest", "SubscribeRequest", "Unsubscribe", "ChallengeVerification"]);

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const postmarkWebhookRoutes: FastifyPluginAsyncTypebox<{ credentials: { user: string; password: string } }> = async (app, opts) => {
  const expected = `Basic ${Buffer.from(`${opts.credentials.user}:${opts.credentials.password}`).toString("base64")}`;

  app.post(
    "/webhooks/postmark",
    { schema: { hide: true, body: Payload } },
    async (req, reply) => {
      if (!sameSecret(req.headers.authorization ?? "", expected)) throw new HttpProblem(401, "unauthenticated", "Webhook credentials required");
      const b = req.body;
      const status = STATUS[b.RecordType];
      const tenantId = b.Metadata?.tenantId;
      const sendId = b.Metadata?.sendId;
      // Not an invitation email, or a record type we don't track: acknowledge so Postmark doesn't retry.
      if (!status || !b.MessageID || !tenantId || !sendId || !UUID.test(tenantId) || !UUID.test(sendId)) return reply.status(200).send({ ok: true, ignored: true });
      if (status === "bounced" && b.Type && NOT_BOUNCES.has(b.Type)) return reply.status(200).send({ ok: true, ignored: true });
      const at = new Date(b.DeliveredAt ?? b.BouncedAt ?? Date.now());
      const detail = status === "delivered" ? null : [b.Type, b.Description].filter(Boolean).join(": ") || null;
      const matched = await withTenant(app.db, { tenantId }, (tx) =>
        registration.recordDelivery(tx, sendId, b.MessageID!, status, detail, Number.isNaN(at.getTime()) ? new Date() : at));
      return reply.status(200).send({ ok: true, matched });
    },
  );
};
