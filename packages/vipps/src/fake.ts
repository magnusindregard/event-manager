import { randomBytes } from "node:crypto";
import {
  type CreatedPayment, type CreatePaymentInput, type Money, type Receipt, type VippsClient, type VippsCredentials, VippsError, type VippsPayment, type Webhook,
} from "./client.js";

// An in-memory Vipps for tests and local stacks (VIPPS=fake). Payments start CREATED; a test
// (or the local landing page) drives them with approve, reject and expire. Capture, cancel and
// refund follow the ePayment rules the platform depends on, and repeat calls with the same
// idempotency key do nothing the second time, as at Vipps.

export interface FakePayment {
  reference: string;
  msn: string;
  amount: Money;
  state: VippsPayment["state"];
  authorized: number;
  captured: number;
  cancelled: number;
  refunded: number;
  returnUrl: string;
  description: string;
  phoneNumber: string | null;
  receipt: Receipt | null;
}

export interface FakeCall {
  op: "create" | "capture" | "cancel" | "refund" | "receipt" | "registerWebhook" | "deleteWebhook";
  reference?: string;
  amount?: number;
  idempotencyKey?: string;
}

export interface FakeVippsOptions {
  /** Where the fake's landing page lives; the redirect URL is `${landingUrl}/<reference>`. */
  landingUrl?: string;
}

export class FakeVipps implements VippsClient {
  readonly payments = new Map<string, FakePayment>();
  readonly webhooks = new Map<string, { url: string; secret: string; msn: string }>();
  readonly calls: FakeCall[] = [];
  /** Client secrets that are refused, as if the keys were wrong. */
  readonly refusedSecrets = new Set<string>();
  /** Makes the next calls fail as if Vipps were down. */
  down = false;
  private readonly seen = new Set<string>();
  private readonly landingUrl: string;

  constructor(opts: FakeVippsOptions = {}) {
    this.landingUrl = opts.landingUrl ?? "https://fake-vipps.test/landing";
  }

  async verifyCredentials(c: VippsCredentials): Promise<void> {
    this.check(c);
  }

  async registerWebhook(c: VippsCredentials, url: string): Promise<Webhook> {
    this.check(c);
    const id = `wh-${randomBytes(6).toString("hex")}`;
    const secret = randomBytes(24).toString("base64url");
    this.webhooks.set(id, { url, secret, msn: c.merchantSerialNumber });
    this.calls.push({ op: "registerWebhook" });
    return { id, secret };
  }

  async deleteWebhook(c: VippsCredentials, id: string): Promise<void> {
    this.check(c);
    this.webhooks.delete(id);
    this.calls.push({ op: "deleteWebhook" });
  }

  async createPayment(c: VippsCredentials, input: CreatePaymentInput, idempotencyKey: string): Promise<CreatedPayment> {
    this.check(c);
    const existing = this.payments.get(input.reference);
    if (existing) {
      if (this.seen.has(`create:${idempotencyKey}`)) return { reference: input.reference, redirectUrl: `${this.landingUrl}/${input.reference}` };
      throw new VippsError(`Vipps POST /epayment/v1/payments: 409 reference ${input.reference} is in use`, 409);
    }
    this.seen.add(`create:${idempotencyKey}`);
    this.payments.set(input.reference, {
      reference: input.reference, msn: c.merchantSerialNumber, amount: input.amount, state: "CREATED",
      authorized: 0, captured: 0, cancelled: 0, refunded: 0,
      returnUrl: input.returnUrl, description: input.description, phoneNumber: input.phoneNumber ?? null, receipt: null,
    });
    this.calls.push({ op: "create", reference: input.reference, amount: input.amount.value, idempotencyKey });
    return { reference: input.reference, redirectUrl: `${this.landingUrl}/${input.reference}` };
  }

  async getPayment(c: VippsCredentials, reference: string): Promise<VippsPayment> {
    this.check(c);
    const p = this.get(reference, c);
    const m = (value: number) => ({ currency: p.amount.currency, value });
    return {
      reference, state: p.state, amount: p.amount, pspReference: null,
      aggregate: { authorizedAmount: m(p.authorized), capturedAmount: m(p.captured), cancelledAmount: m(p.cancelled), refundedAmount: m(p.refunded) },
    };
  }

  async capture(c: VippsCredentials, reference: string, amount: Money, idempotencyKey: string): Promise<void> {
    this.check(c);
    const p = this.get(reference, c);
    if (this.seen.has(`capture:${idempotencyKey}`)) return;
    if (p.state !== "AUTHORIZED" || p.cancelled > 0) throw new VippsError(`Vipps capture: 400 payment is ${p.state}`, 400);
    if (p.captured + amount.value > p.authorized) throw new VippsError("Vipps capture: 400 more than authorised", 400);
    p.captured += amount.value;
    this.seen.add(`capture:${idempotencyKey}`);
    this.calls.push({ op: "capture", reference, amount: amount.value, idempotencyKey });
  }

  async cancel(c: VippsCredentials, reference: string, idempotencyKey: string): Promise<void> {
    this.check(c);
    const p = this.get(reference, c);
    if (this.seen.has(`cancel:${idempotencyKey}`)) return;
    if (p.state === "CREATED") p.state = "TERMINATED";
    else if (p.state === "AUTHORIZED") {
      if (p.captured > 0) throw new VippsError("Vipps cancel: 400 payment is captured", 400);
      p.cancelled = p.authorized;
      p.state = "TERMINATED";
    } else throw new VippsError(`Vipps cancel: 400 payment is ${p.state}`, 400);
    this.seen.add(`cancel:${idempotencyKey}`);
    this.calls.push({ op: "cancel", reference, idempotencyKey });
  }

  async refund(c: VippsCredentials, reference: string, amount: Money, idempotencyKey: string): Promise<void> {
    this.check(c);
    const p = this.get(reference, c);
    if (this.seen.has(`refund:${idempotencyKey}`)) return;
    if (p.refunded + amount.value > p.captured) throw new VippsError("Vipps refund: 400 more than captured", 400);
    p.refunded += amount.value;
    this.seen.add(`refund:${idempotencyKey}`);
    this.calls.push({ op: "refund", reference, amount: amount.value, idempotencyKey });
  }

  async sendReceipt(c: VippsCredentials, reference: string, receipt: Receipt): Promise<void> {
    this.check(c);
    this.get(reference, c).receipt = receipt;
    this.calls.push({ op: "receipt", reference });
  }

  // ── Driving the buyer's side ───────────────────────────────────────────────

  /** The buyer approves in the app. */
  approve(reference: string): void {
    const p = this.mustGet(reference);
    if (p.state !== "CREATED") throw new Error(`FakeVipps: ${reference} is ${p.state}`);
    p.state = "AUTHORIZED";
    p.authorized = p.amount.value;
  }

  /** The buyer rejects (ABORTED). */
  reject(reference: string): void {
    const p = this.mustGet(reference);
    if (p.state !== "CREATED") throw new Error(`FakeVipps: ${reference} is ${p.state}`);
    p.state = "ABORTED";
  }

  /** The buyer never answered (EXPIRED). */
  expire(reference: string): void {
    const p = this.mustGet(reference);
    if (p.state !== "CREATED") throw new Error(`FakeVipps: ${reference} is ${p.state}`);
    p.state = "EXPIRED";
  }

  callsFor(reference: string, op?: FakeCall["op"]): FakeCall[] {
    return this.calls.filter((c) => c.reference === reference && (!op || c.op === op));
  }

  private check(c: VippsCredentials) {
    if (this.down) throw new VippsError("Vipps did not answer: fake is down", 0);
    if (this.refusedSecrets.has(c.clientSecret)) throw new VippsError("Vipps POST /accesstoken/get: 401 invalid_client", 401);
  }

  private get(reference: string, c: VippsCredentials): FakePayment {
    const p = this.payments.get(reference);
    if (!p || p.msn !== c.merchantSerialNumber) throw new VippsError(`Vipps /epayment/v1/payments/${reference}: 404 not found`, 404);
    return p;
  }

  private mustGet(reference: string): FakePayment {
    const p = this.payments.get(reference);
    if (!p) throw new Error(`FakeVipps: no payment ${reference}`);
    return p;
  }
}
