import { describe, expect, it } from "vitest";
import { FakeHubSpot, HttpHubSpot, HubSpotError, OPTIONAL_SCOPES, REQUIRED_SCOPES, signState, verifyState } from "../src/index.js";

const app = { clientId: "cid", clientSecret: "secret", redirectUrl: "https://admin.test/integrations/hubspot/callback" };

/** A fetch that answers from a list of canned responses and records the requests. */
function stubFetch(responses: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const requests: { method: string; url: string; headers: Record<string, string>; body: string | undefined }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    requests.push({ method: init.method!, url, headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    const r = responses.shift()!;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fn, requests };
}

describe("OAuth state", () => {
  it("round-trips, and refuses a forged, expired or other-secret state", () => {
    const now = new Date("2026-11-21T10:00:00Z");
    const s = signState("secret", { tenantId: "t1", userId: "u1" }, 600, now);
    expect(verifyState("secret", s, now)).toEqual({ tenantId: "t1", userId: "u1", expiresAt: new Date("2026-11-21T10:10:00Z") });
    expect(verifyState("other", s, now)).toBeNull();
    expect(verifyState("secret", s, new Date("2026-11-21T10:10:00Z"))).toBeNull();
    const [body, sig] = s.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), t: "t2" })).toString("base64url");
    expect(verifyState("secret", `${forged}.${sig}`, now)).toBeNull();
    expect(verifyState("secret", "garbage", now)).toBeNull();
  });
});

describe("HttpHubSpot", () => {
  it("builds the install URL with required and optional scopes", () => {
    const u = new URL(new HttpHubSpot(app).authorizeUrl("st", { required: REQUIRED_SCOPES, optional: OPTIONAL_SCOPES }));
    expect(u.origin + u.pathname).toBe("https://app.hubspot.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe(app.redirectUrl);
    expect(u.searchParams.get("scope")?.split(" ")).toContain("crm.objects.contacts.write");
    expect(u.searchParams.get("optional_scope")).toBe(OPTIONAL_SCOPES.join(" "));
    expect(u.searchParams.get("state")).toBe("st");
  });

  it("exchanges a code with the client credentials, form-encoded", async () => {
    const { fn, requests } = stubFetch([{ status: 200, body: { access_token: "at", refresh_token: "rt", expires_in: 1800 } }]);
    const t = await new HttpHubSpot(app, fn).exchangeCode("c1");
    expect(t).toMatchObject({ accessToken: "at", refreshToken: "rt" });
    expect(t.expiresAt.getTime()).toBeGreaterThan(Date.now() + 1700_000);
    expect(requests[0]).toMatchObject({ method: "POST", url: "https://api.hubapi.com/oauth/v1/token" });
    expect(Object.fromEntries(new URLSearchParams(requests[0]!.body))).toEqual({
      client_id: "cid", client_secret: "secret", grant_type: "authorization_code", redirect_uri: app.redirectUrl, code: "c1",
    });
  });

  it("reads the portal and scopes of a token", async () => {
    const { fn, requests } = stubFetch([{ status: 200, body: { hub_id: 4711, scopes: ["oauth", "content"], user: "a@b.test", token_type: "access" } }]);
    expect(await new HttpHubSpot(app, fn).tokenInfo("at/1")).toEqual({ portalId: "4711", scopes: ["oauth", "content"], user: "a@b.test" });
    expect(requests[0]!.url).toBe("https://api.hubapi.com/oauth/v1/access-tokens/at%2F1");
  });

  it("reads the portal behind a token", async () => {
    const { fn, requests } = stubFetch([{ status: 200, body: { portalId: 4711, timeZone: "Europe/Oslo", accountType: "STANDARD", uiDomain: "app-eu1.hubspot.com" } }]);
    expect(await new HttpHubSpot(app, fn).accountDetails("at")).toEqual({ portalId: "4711", timeZone: "Europe/Oslo", accountType: "STANDARD" });
    expect(`${requests[0]!.method} ${requests[0]!.url}`).toBe("GET https://api.hubapi.com/account-info/v3/details");
    expect(requests[0]!.headers.authorization).toBe("Bearer at");
  });

  it("reports refused tokens and rate limits, and never puts a token in the message", async () => {
    const { fn } = stubFetch([
      { status: 401, body: { message: "expired" } },
      { status: 429, body: { message: "slow down" }, headers: { "retry-after": "10" } },
    ]);
    const h = new HttpHubSpot(app, fn);
    const e1 = (await h.tokenInfo("secret-token").catch((e: unknown) => e)) as HubSpotError;
    expect(e1).toBeInstanceOf(HubSpotError);
    expect(e1).toMatchObject({ status: 401, unauthorized: true, retryable: false });
    expect(e1.message).not.toContain("secret-token");
    const e2 = (await h.accountDetails("at").catch((e: unknown) => e)) as HubSpotError;
    expect(e2).toMatchObject({ status: 429, retryable: true, retryAfterSeconds: 10 });
  });

  it("puts HubSpot's validation details in the message, so a 400 says what is wrong", async () => {
    const { fn } = stubFetch([
      { status: 400, body: { status: "error", message: "Invalid request to flow creation", errors: [{ message: "isEnabled cannot be true on create", in: "isEnabled" }], context: { flowId: ["1"] } } },
    ]);
    const e = (await new HttpHubSpot(app, fn).createNonMarketingWorkflow("at", "EM · Set to non-marketing", "9").catch((x: unknown) => x)) as HubSpotError;
    expect(e).toBeInstanceOf(HubSpotError);
    expect(e.message).toContain("Invalid request to flow creation (isEnabled: isEnabled cannot be true on create)");
  });

  it("creates the non-marketing workflow switched off, as spike run 16 did, and switches it on with the flow's own fields", async () => {
    const flow = { id: "77", name: "EM · Set to non-marketing", isEnabled: false, revisionId: "3", type: "CONTACT_FLOW", createdAt: "x", updatedAt: "y" };
    const { fn, requests } = stubFetch([{ status: 201, body: flow }, { status: 200, body: flow }, { status: 200, body: { ...flow, isEnabled: true } }]);
    const h = new HttpHubSpot(app, fn);
    expect(await h.createNonMarketingWorkflow("at", flow.name, "9")).toMatchObject({ id: "77", enabled: false });
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({ isEnabled: false, actions: [{ actionTypeId: "0-31", fields: { marketableType: "NON_MARKETABLE" } }] });
    await h.enableWorkflow("at", "77");
    expect(`${requests[2]!.method} ${requests[2]!.url}`).toBe("PUT https://api.hubapi.com/automation/v4/flows/77");
    expect(JSON.parse(requests[2]!.body!)).toEqual({ name: flow.name, isEnabled: true, revisionId: "3", type: "CONTACT_FLOW" });
  });

  it("revoking a token HubSpot no longer knows is fine", async () => {
    const { fn } = stubFetch([{ status: 404, body: { message: "not found" } }]);
    await expect(new HttpHubSpot(app, fn).revoke("rt")).resolves.toBeUndefined();
  });
});

describe("FakeHubSpot in local mode", () => {
  it("approves the install at once and accepts tokens from another process", async () => {
    const api = new FakeHubSpot(undefined, { redirectUrl: "http://localhost:5173/integrations/hubspot/callback", portalId: "1" });
    const u = new URL(api.authorizeUrl("st", { required: ["oauth"], optional: [] }));
    expect(u.origin + u.pathname).toBe("http://localhost:5173/integrations/hubspot/callback");
    expect(u.searchParams.get("state")).toBe("st");
    const t = await api.exchangeCode(u.searchParams.get("code")!);
    const worker = new FakeHubSpot(undefined, { redirectUrl: "", portalId: "1" });
    await expect(worker.accountDetails(t.accessToken)).resolves.toMatchObject({ portalId: "1" });
    await expect(worker.refresh(t.refreshToken)).resolves.toMatchObject({ refreshToken: t.refreshToken });
  });
});

describe("the HubSpot app definition", () => {
  it("declares the scopes the install URL asks for", async () => {
    const { readFile } = await import("node:fs/promises");
    const app = JSON.parse(await readFile(new URL("../../../integrations/hubspot-app/src/app/app-hsmeta.json", import.meta.url), "utf8")) as {
      config: { auth: { requiredScopes: string[]; optionalScopes: string[] } };
    };
    expect(app.config.auth.requiredScopes).toEqual([...REQUIRED_SCOPES]);
    expect(app.config.auth.optionalScopes).toEqual([...OPTIONAL_SCOPES]);
  });
});
