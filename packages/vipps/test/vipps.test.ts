import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeVipps, HttpVipps, SharedFakeVipps, signHeaders, type VippsCredentials, VippsError, verifyWebhook } from "../src/index.js";

const creds: VippsCredentials = { environment: "test", merchantSerialNumber: "123456", clientId: "cid", clientSecret: "secret", subscriptionKey: "sub" };

type Seen = { method: string; url: string; headers: Record<string, string>; body: unknown };

function stub(answers: Record<string, (req: Seen) => { status: number; body?: unknown }>) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const req = { method: init.method!, url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    seen.push(req);
    const key = `${req.method} ${new URL(url).pathname}`;
    const a = answers[key]?.(req) ?? { status: 404, body: { title: "Not found" } };
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

const token = () => ({ status: 200, body: { access_token: "tok", expires_in: "3600" } });

describe("HttpVipps", () => {
  it("fetches a token with the merchant's keys and caches it", async () => {
    const { seen, fetchFn } = stub({ "POST /accesstoken/get": token, "GET /epayment/v1/payments/ref-12345678": () => ({ status: 200, body: { reference: "ref-12345678", state: "CREATED", amount: { currency: "NOK", value: 100 } } }) });
    const v = new HttpVipps({ fetchFn });
    await v.getPayment(creds, "ref-12345678");
    await v.getPayment(creds, "ref-12345678");
    expect(seen.filter((s) => s.url.endsWith("/accesstoken/get"))).toHaveLength(1);
    const t = seen[0]!;
    expect(t.url).toBe("https://apitest.vipps.no/accesstoken/get");
    expect(t.headers).toMatchObject({ client_id: "cid", client_secret: "secret", "Ocp-Apim-Subscription-Key": "sub", "Merchant-Serial-Number": "123456" });
    expect(seen[1]!.headers).toMatchObject({ authorization: "Bearer tok", "Vipps-System-Name": "event-manager" });
  });

  it("creates a payment with an idempotency key and reads the aggregate", async () => {
    const { seen, fetchFn } = stub({
      "POST /accesstoken/get": token,
      "POST /epayment/v1/payments": () => ({ status: 201, body: { reference: "ref-12345678", redirectUrl: "https://landing" } }),
      "GET /epayment/v1/payments/ref-12345678": () => ({
        status: 200,
        body: { reference: "ref-12345678", state: "AUTHORIZED", amount: { currency: "NOK", value: 45000 }, aggregate: { authorizedAmount: { currency: "NOK", value: 45000 } } },
      }),
    });
    const v = new HttpVipps({ fetchFn });
    const created = await v.createPayment(creds, { reference: "ref-12345678", amount: { currency: "NOK", value: 45000 }, returnUrl: "https://back", description: "Hamlet", phoneNumber: "4791234567" }, "idem-1");
    expect(created.redirectUrl).toBe("https://landing");
    const post = seen.find((s) => s.url.endsWith("/epayment/v1/payments"))!;
    expect(post.headers["Idempotency-Key"]).toBe("idem-1");
    expect(post.body).toMatchObject({ userFlow: "WEB_REDIRECT", paymentMethod: { type: "WALLET" }, customer: { phoneNumber: "4791234567" }, amount: { value: 45000 } });
    const p = await v.getPayment(creds, "ref-12345678");
    expect(p.state).toBe("AUTHORIZED");
    expect(p.aggregate.authorizedAmount.value).toBe(45000);
    expect(p.aggregate.capturedAmount.value).toBe(0);
  });

  it("raises VippsError with the status, unauthorised for bad keys", async () => {
    const { fetchFn } = stub({ "POST /accesstoken/get": () => ({ status: 401, body: { error: "invalid_client", error_description: "bad" } }) });
    const err = await new HttpVipps({ fetchFn }).verifyCredentials(creds).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VippsError);
    expect((err as VippsError).unauthorized).toBe(true);
    expect((err as VippsError).message).toMatch(/invalid_client/);
  });

  it("treats a webhook Vipps no longer has as deleted", async () => {
    const { fetchFn } = stub({ "POST /accesstoken/get": token, "DELETE /webhooks/v1/webhooks/wh1": () => ({ status: 404 }) });
    await expect(new HttpVipps({ fetchFn }).deleteWebhook(creds, "wh1")).resolves.toBeUndefined();
  });

  it("uses the production base URL for production keys", async () => {
    const { seen, fetchFn } = stub({ "POST /accesstoken/get": token });
    await new HttpVipps({ fetchFn }).verifyCredentials({ ...creds, environment: "production" });
    expect(seen[0]!.url).toBe("https://api.vipps.no/accesstoken/get");
  });
});

describe("webhook signatures", () => {
  const req = { method: "POST", pathAndQuery: "/webhooks/vipps/a/b", host: "api.example.com", body: JSON.stringify({ reference: "r", name: "AUTHORIZED" }) };

  it("accepts a request signed with the secret", () => {
    const h = signHeaders("s3cret", req);
    expect(verifyWebhook("s3cret", { ...req, date: h["x-ms-date"]!, contentSha256: h["x-ms-content-sha256"]!, authorization: h.authorization! })).toBe(true);
  });

  it("refuses another secret, a changed body or a changed path", () => {
    const h = signHeaders("s3cret", req);
    const signed = { ...req, date: h["x-ms-date"]!, contentSha256: h["x-ms-content-sha256"]!, authorization: h.authorization! };
    expect(verifyWebhook("other", signed)).toBe(false);
    expect(verifyWebhook("s3cret", { ...signed, body: req.body.replace("AUTHORIZED", "CAPTURED") })).toBe(false);
    expect(verifyWebhook("s3cret", { ...signed, pathAndQuery: "/webhooks/vipps/a/c" })).toBe(false);
    expect(verifyWebhook("s3cret", { ...signed, authorization: "Bearer x" })).toBe(false);
  });
});

describe("FakeVipps", () => {
  it("authorises, captures and refunds within the rules, idempotently", async () => {
    const v = new FakeVipps();
    await v.createPayment(creds, { reference: "ref-12345678", amount: { currency: "NOK", value: 1000 }, returnUrl: "x", description: "d" }, "k1");
    await expect(v.capture(creds, "ref-12345678", { currency: "NOK", value: 1000 }, "c1")).rejects.toThrow(VippsError);
    v.approve("ref-12345678");
    await v.capture(creds, "ref-12345678", { currency: "NOK", value: 1000 }, "c2");
    await v.capture(creds, "ref-12345678", { currency: "NOK", value: 1000 }, "c2");
    expect(v.callsFor("ref-12345678", "capture")).toHaveLength(1);
    await v.refund(creds, "ref-12345678", { currency: "NOK", value: 400 }, "r1");
    await expect(v.refund(creds, "ref-12345678", { currency: "NOK", value: 700 }, "r2")).rejects.toThrow(/more than captured/);
    expect((await v.getPayment(creds, "ref-12345678")).aggregate).toMatchObject({ capturedAmount: { value: 1000 }, refundedAmount: { value: 400 } });
  });

  it("shares its payments between processes through a file (SharedFakeVipps)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "fake-vipps-")), "state.json");
    const attendee = new SharedFakeVipps(file);
    const api = new SharedFakeVipps(file);
    await attendee.createPayment(creds, { reference: "ref-shared01", amount: { currency: "NOK", value: 500 }, returnUrl: "x", description: "d" }, "k");
    attendee.approve("ref-shared01");
    await api.capture(creds, "ref-shared01", { currency: "NOK", value: 500 }, "c");
    await api.refund(creds, "ref-shared01", { currency: "NOK", value: 200 }, "r");
    expect((await attendee.getPayment(creds, "ref-shared01")).aggregate).toMatchObject({ capturedAmount: { value: 500 }, refundedAmount: { value: 200 } });
    expect(attendee.find("ref-shared01")?.state).toBe("AUTHORIZED");
  });

  it("refuses keys it was told to refuse, and other merchants' payments", async () => {
    const v = new FakeVipps();
    v.refusedSecrets.add("secret");
    await expect(v.verifyCredentials(creds)).rejects.toMatchObject({ unauthorized: true });
    const ok = { ...creds, clientSecret: "fine" };
    await v.createPayment(ok, { reference: "ref-12345678", amount: { currency: "NOK", value: 1 }, returnUrl: "x", description: "d" }, "k");
    await expect(v.getPayment({ ...ok, merchantSerialNumber: "999999" }, "ref-12345678")).rejects.toMatchObject({ status: 404 });
  });
});
