// What the payments module needs from a payment provider (ADR 0018). Vipps MobilePay is the
// first adapter (packages/vipps, whose client has this shape); Stripe would be a second one.
// The domain never imports a provider package: apps pass the client in.

export type ProviderEnvironment = "test" | "production";

/** The client's own merchant keys. */
export interface ProviderCredentials {
  environment: ProviderEnvironment;
  merchantSerialNumber: string;
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
}

export interface Money {
  currency: string;
  value: number;
}

export type ProviderPaymentState = "CREATED" | "AUTHORIZED" | "ABORTED" | "EXPIRED" | "TERMINATED";

export interface ProviderPayment {
  reference: string;
  state: ProviderPaymentState;
  amount: Money;
  aggregate: { authorizedAmount: Money; cancelledAmount: Money; capturedAmount: Money; refundedAmount: Money };
  pspReference: string | null;
}

export interface ReceiptLine {
  name: string;
  id: string;
  totalAmount: number;
  totalAmountExcludingTax: number;
  totalTaxAmount: number;
  taxPercentage: number;
  unitPrice: number;
  quantity: number;
}

export interface PaymentProvider {
  verifyCredentials(c: ProviderCredentials): Promise<void>;
  registerWebhook(c: ProviderCredentials, url: string): Promise<{ id: string; secret: string }>;
  deleteWebhook(c: ProviderCredentials, id: string): Promise<void>;
  createPayment(
    c: ProviderCredentials,
    input: { reference: string; amount: Money; returnUrl: string; description: string; phoneNumber?: string | null },
    idempotencyKey: string,
  ): Promise<{ reference: string; redirectUrl: string }>;
  getPayment(c: ProviderCredentials, reference: string): Promise<ProviderPayment>;
  capture(c: ProviderCredentials, reference: string, amount: Money, idempotencyKey: string): Promise<void>;
  /** transactionOnly: only a payment not yet approved (an approved one is refused and left alone). */
  cancel(c: ProviderCredentials, reference: string, idempotencyKey: string, opts?: { transactionOnly?: boolean }): Promise<void>;
  refund(c: ProviderCredentials, reference: string, amount: Money, idempotencyKey: string): Promise<void>;
  sendReceipt(c: ProviderCredentials, reference: string, receipt: { currency: string; lines: ReceiptLine[]; receiptNumber: string }): Promise<void>;
}

/** Provider errors carry an HTTP status; 401/403 mean the keys were refused. */
export const refusedKeys = (e: unknown): boolean => {
  const s = (e as { status?: unknown } | null)?.status;
  return s === 401 || s === 403;
};

/**
 * Worth trying again later: the provider did not answer, answered 5xx or 429, or 423 (Vipps locks
 * a payment while it processes another change to it).
 */
export const providerUnavailable = (e: unknown): boolean => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" && (s === 0 || s === 423 || s === 429 || s >= 500);
};

export const providerMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);
