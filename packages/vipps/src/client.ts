// The Vipps MobilePay calls the platform makes (docs/checkout.md, ADR 0018). Every call is made
// with the client's own merchant keys: the platform initiates payments on the client's merchant
// account and never holds money. Tests and local stacks use FakeVipps, so nothing calls Vipps
// unless the API and worker are started with VIPPS=http.
//
// APIs: Access token, ePayment v1 (create, get, capture, cancel, refund), Webhooks v1 and Order
// Management v2 (the receipt shown in the buyer's Vipps app).

export type VippsEnvironment = "test" | "production";

/** The client's merchant keys, as they enter them in the admin. */
export interface VippsCredentials {
  environment: VippsEnvironment;
  merchantSerialNumber: string;
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
}

/** Minor units: øre for NOK. */
export interface Money {
  currency: string;
  value: number;
}

export interface CreatePaymentInput {
  /** Ours, 8–64 of A–Z, a–z, 0–9 and -. The payment's id at Vipps too. */
  reference: string;
  amount: Money;
  /** Where Vipps sends the buyer back, approved or not. */
  returnUrl: string;
  /** Shown to the buyer in the app, at most 100 characters. */
  description: string;
  /** Prefills the buyer's number on the landing page: digits with country code, e.g. 4791234567. */
  phoneNumber?: string | null;
}

export interface CreatedPayment {
  reference: string;
  /** The Vipps landing page; send the buyer here. */
  redirectUrl: string;
}

/** ePayment states. AUTHORIZED stays AUTHORIZED after capture; the aggregate tells the rest. */
export type VippsPaymentState = "CREATED" | "AUTHORIZED" | "ABORTED" | "EXPIRED" | "TERMINATED";

export interface PaymentAggregate {
  authorizedAmount: Money;
  cancelledAmount: Money;
  capturedAmount: Money;
  refundedAmount: Money;
}

/** What Vipps says about a payment; the source of truth for the state machine. */
export interface VippsPayment {
  reference: string;
  state: VippsPaymentState;
  amount: Money;
  aggregate: PaymentAggregate;
  pspReference: string | null;
}

export interface Webhook {
  id: string;
  /** Signs the webhook requests (HMAC-SHA256). Vipps shows it only when the webhook is registered. */
  secret: string;
}

/** The ePayment events the platform listens to. */
export const PAYMENT_EVENTS = [
  "epayments.payment.authorized.v1",
  "epayments.payment.aborted.v1",
  "epayments.payment.expired.v1",
  "epayments.payment.cancelled.v1",
  "epayments.payment.captured.v1",
  "epayments.payment.refunded.v1",
  "epayments.payment.terminated.v1",
] as const;

/** A line on the receipt (Order Management v2); amounts in minor units, VAT included where it says so. */
export interface ReceiptLine {
  name: string;
  id: string;
  totalAmount: number;
  totalAmountExcludingTax: number;
  totalTaxAmount: number;
  /** Whole per cent, as Vipps takes it (0, 12, 15, 25). */
  taxPercentage: number;
  unitPrice: number;
  quantity: number;
}

export interface Receipt {
  currency: string;
  lines: ReceiptLine[];
  receiptNumber: string;
}

export class VippsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VippsError";
  }
  /** The keys are wrong, or not allowed for this merchant serial number. */
  get unauthorized() {
    return this.status === 401 || this.status === 403;
  }
  /** 423: the payment is locked while Vipps processes another change to it. */
  get retryable() {
    return this.status === 423 || this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export interface VippsClient {
  /** Fetches an access token: succeeds only if the keys and serial number belong together. */
  verifyCredentials(c: VippsCredentials): Promise<void>;
  registerWebhook(c: VippsCredentials, url: string): Promise<Webhook>;
  /** A webhook Vipps no longer has is not an error. */
  deleteWebhook(c: VippsCredentials, id: string): Promise<void>;
  createPayment(c: VippsCredentials, input: CreatePaymentInput, idempotencyKey: string): Promise<CreatedPayment>;
  getPayment(c: VippsCredentials, reference: string): Promise<VippsPayment>;
  capture(c: VippsCredentials, reference: string, amount: Money, idempotencyKey: string): Promise<void>;
  /** Cancels what is authorised and not captured; a created payment can no longer be approved. */
  cancel(c: VippsCredentials, reference: string, idempotencyKey: string): Promise<void>;
  refund(c: VippsCredentials, reference: string, amount: Money, idempotencyKey: string): Promise<void>;
  sendReceipt(c: VippsCredentials, reference: string, receipt: Receipt): Promise<void>;
}

export const BASE_URLS: Record<VippsEnvironment, string> = {
  test: "https://apitest.vipps.no",
  production: "https://api.vipps.no",
};

/** Sent on every call (Vipps asks integrators to identify themselves). */
export interface SystemInfo {
  name: string;
  version: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface HttpVippsOptions {
  fetchFn?: typeof fetch;
  system?: SystemInfo;
  timeoutMs?: number;
  /** Overrides BASE_URLS, e.g. for a recorded test server. */
  baseUrls?: Partial<Record<VippsEnvironment, string>>;
  now?: () => number;
}

export class HttpVipps implements VippsClient {
  private readonly fetchFn: typeof fetch;
  private readonly system: SystemInfo;
  private readonly timeoutMs: number;
  private readonly baseUrls: Record<VippsEnvironment, string>;
  private readonly now: () => number;
  /** Access tokens per merchant and key, until a minute before they expire. */
  private readonly tokens = new Map<string, CachedToken>();

  constructor(opts: HttpVippsOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.system = opts.system ?? { name: "event-manager", version: "1.0.0" };
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.baseUrls = { ...BASE_URLS, ...opts.baseUrls };
    this.now = opts.now ?? Date.now;
  }

  async verifyCredentials(c: VippsCredentials): Promise<void> {
    this.tokens.delete(tokenKey(c));
    await this.accessToken(c);
  }

  async registerWebhook(c: VippsCredentials, url: string): Promise<Webhook> {
    const r = (await this.call(c, "POST", "/webhooks/v1/webhooks", { url, events: PAYMENT_EVENTS })) as { id?: string; secret?: string } | null;
    if (!r?.id || !r.secret) throw new VippsError("Vipps POST /webhooks/v1/webhooks: no webhook in the answer", 502);
    return { id: r.id, secret: r.secret };
  }

  async deleteWebhook(c: VippsCredentials, id: string): Promise<void> {
    try {
      await this.call(c, "DELETE", `/webhooks/v1/webhooks/${encodeURIComponent(id)}`);
    } catch (e) {
      if (!(e instanceof VippsError && e.status === 404)) throw e;
    }
  }

  async createPayment(c: VippsCredentials, input: CreatePaymentInput, idempotencyKey: string): Promise<CreatedPayment> {
    const body = {
      amount: input.amount,
      paymentMethod: { type: "WALLET" },
      ...(input.phoneNumber ? { customer: { phoneNumber: input.phoneNumber } } : {}),
      reference: input.reference,
      returnUrl: input.returnUrl,
      userFlow: "WEB_REDIRECT",
      paymentDescription: input.description.slice(0, 100),
    };
    const r = (await this.call(c, "POST", "/epayment/v1/payments", body, idempotencyKey)) as { redirectUrl?: string; reference?: string } | null;
    if (!r?.redirectUrl) throw new VippsError("Vipps POST /epayment/v1/payments: no redirectUrl in the answer", 502);
    return { reference: r.reference ?? input.reference, redirectUrl: r.redirectUrl };
  }

  async getPayment(c: VippsCredentials, reference: string): Promise<VippsPayment> {
    const r = (await this.call(c, "GET", `/epayment/v1/payments/${encodeURIComponent(reference)}`)) as RawPayment | null;
    if (!r) throw new VippsError(`Vipps GET /epayment/v1/payments/${reference}: empty answer`, 502);
    return toPayment(r, reference);
  }

  async capture(c: VippsCredentials, reference: string, amount: Money, idempotencyKey: string): Promise<void> {
    await this.call(c, "POST", `/epayment/v1/payments/${encodeURIComponent(reference)}/capture`, { modificationAmount: amount }, idempotencyKey);
  }

  async cancel(c: VippsCredentials, reference: string, idempotencyKey: string): Promise<void> {
    await this.call(c, "POST", `/epayment/v1/payments/${encodeURIComponent(reference)}/cancel`, {}, idempotencyKey);
  }

  async refund(c: VippsCredentials, reference: string, amount: Money, idempotencyKey: string): Promise<void> {
    await this.call(c, "POST", `/epayment/v1/payments/${encodeURIComponent(reference)}/refund`, { modificationAmount: amount }, idempotencyKey);
  }

  async sendReceipt(c: VippsCredentials, reference: string, receipt: Receipt): Promise<void> {
    const body = {
      orderLines: receipt.lines.map((l) => ({
        name: l.name.slice(0, 2048),
        id: l.id,
        totalAmount: l.totalAmount,
        totalAmountExcludingTax: l.totalAmountExcludingTax,
        totalTaxAmount: l.totalTaxAmount,
        taxPercentage: l.taxPercentage,
        unitInfo: { unitPrice: l.unitPrice, quantity: String(l.quantity), quantityUnit: "PCS" },
      })),
      bottomLine: { currency: receipt.currency, receiptNumber: receipt.receiptNumber },
    };
    await this.call(c, "POST", `/order-management/v2/ecom/receipts/${encodeURIComponent(reference)}`, body);
  }

  private async accessToken(c: VippsCredentials): Promise<string> {
    const key = tokenKey(c);
    const hit = this.tokens.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.token;
    const res = await this.send("POST", `${this.baseUrls[c.environment]}/accesstoken/get`, {
      ...this.headers(c),
      client_id: c.clientId,
      client_secret: c.clientSecret,
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: string | number };
    if (!body.access_token) throw new VippsError("Vipps POST /accesstoken/get: no token in the answer", 502);
    const seconds = Number(body.expires_in) || 3600;
    this.tokens.set(key, { token: body.access_token, expiresAt: this.now() + Math.max(0, seconds - 60) * 1000 });
    return body.access_token;
  }

  private headers(c: VippsCredentials): Record<string, string> {
    return {
      "Ocp-Apim-Subscription-Key": c.subscriptionKey,
      "Merchant-Serial-Number": c.merchantSerialNumber,
      "Vipps-System-Name": this.system.name,
      "Vipps-System-Version": this.system.version,
      "Vipps-System-Plugin-Name": "event-manager-checkout",
      "Vipps-System-Plugin-Version": this.system.version,
    };
  }

  private async call(c: VippsCredentials, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
    const token = await this.accessToken(c);
    const headers: Record<string, string> = { ...this.headers(c), authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET" && method !== "DELETE") headers["Idempotency-Key"] = idempotencyKey ?? crypto.randomUUID();
    let res: Response;
    try {
      res = await this.send(method, `${this.baseUrls[c.environment]}${path}`, headers, body === undefined ? undefined : JSON.stringify(body));
    } catch (e) {
      // An expired or revoked token: fetch a new one once.
      if (e instanceof VippsError && e.status === 401) {
        this.tokens.delete(tokenKey(c));
        headers.authorization = `Bearer ${await this.accessToken(c)}`;
        res = await this.send(method, `${this.baseUrls[c.environment]}${path}`, headers, body === undefined ? undefined : JSON.stringify(body));
      } else {
        throw e;
      }
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  private async send(method: string, url: string, headers: Record<string, string>, body?: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new VippsError(`Vipps did not answer: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 300);
    try {
      // ePayment answers with RFC 7807 problems; the token API with {error, error_description}.
      const j = JSON.parse(text) as { title?: string; detail?: string; error?: string; error_description?: string };
      message = [j.title ?? j.error, j.detail ?? j.error_description].filter(Boolean).join(": ") || message;
    } catch {
      // not JSON
    }
    throw new VippsError(`Vipps ${method} ${new URL(url).pathname}: ${res.status} ${message}`, res.status);
  }
}

const tokenKey = (c: VippsCredentials) => `${c.environment}:${c.merchantSerialNumber}:${c.clientId}:${c.subscriptionKey}:${c.clientSecret}`;

type RawPayment = {
  reference?: string;
  state?: VippsPaymentState;
  amount?: Money;
  aggregate?: Partial<PaymentAggregate>;
  pspReference?: string;
};

function toPayment(r: RawPayment, reference: string): VippsPayment {
  const currency = r.amount?.currency ?? "NOK";
  const zero = { currency, value: 0 };
  return {
    reference: r.reference ?? reference,
    state: r.state ?? "CREATED",
    amount: r.amount ?? zero,
    aggregate: {
      authorizedAmount: r.aggregate?.authorizedAmount ?? zero,
      cancelledAmount: r.aggregate?.cancelledAmount ?? zero,
      capturedAmount: r.aggregate?.capturedAmount ?? zero,
      refundedAmount: r.aggregate?.refundedAmount ?? zero,
    },
    pspReference: r.pspReference ?? null,
  };
}
