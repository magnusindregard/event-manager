import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { tenancy } from "@event-manager/domain";
import { buildApp } from "../src/app.js";
import { DEV_ISSUER, devVerifier } from "../src/auth.js";

const SECRET = "test-secret";
let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let accountA: string;
let accountB: string;

const token = (email: string) =>
  new SignJWT({ email, name: email.split("@")[0] })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(DEV_ISSUER)
    .setSubject(email)
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));

async function call(method: string, url: string, opts: { as?: string; account?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.as) headers.authorization = `Bearer ${await token(opts.as)}`;
  if (opts.account) headers["account-id"] = opts.account;
  const res = await app.inject({ method: method as "GET", url, headers, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
  return { status: res.statusCode, headers: res.headers, body: res.body ? res.json() : undefined };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildApp({ db, verifier: devVerifier(SECRET) });
  accountA = (await tenancy.createAccount(db, { slug: "acme-a", name: "A", ownerEmail: "owner@a.test" })).id;
  accountB = (await tenancy.createAccount(db, { slug: "acme-b", name: "B", ownerEmail: "owner@b.test" })).id;
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("/v1", () => {
  it("rejects missing tokens with problem details", async () => {
    const res = await call("GET", "/v1/me");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body).toMatchObject({ status: 401, code: "unauthenticated" });
  });

  it("GET /me lists the accounts the user was invited to", async () => {
    const res = await call("GET", "/v1/me", { as: "owner@a.test" });
    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([{ accountId: accountA, slug: "acme-a", name: "A", roles: ["owner"] }]);
  });

  it("does not let a user read an account they are not a member of", async () => {
    const res = await call("GET", "/v1/account", { as: "owner@a.test", account: accountB });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("requires Account-Id", async () => {
    const res = await call("GET", "/v1/account", { as: "owner@a.test" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("account_id_required");
  });

  it("updates settings with ETag / If-Match and records an audit entry", async () => {
    const get = await call("GET", "/v1/account", { as: "owner@a.test", account: accountA });
    expect(get.status).toBe(200);
    const etag = get.headers.etag as string;
    expect(etag).toBe(`"${get.body.version}"`);

    const noMatch = await call("PATCH", "/v1/account", { as: "owner@a.test", account: accountA, body: { name: "A2" } });
    expect(noMatch.status).toBe(428);
    expect(noMatch.body.code).toBe("precondition_required");

    const ok = await call("PATCH", "/v1/account", { as: "owner@a.test", account: accountA, body: { name: "A2" }, headers: { "if-match": etag } });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe("A2");
    expect(ok.headers.etag).toBe(`"${get.body.version + 1}"`);

    const stale = await call("PATCH", "/v1/account", { as: "owner@a.test", account: accountA, body: { name: "A3" }, headers: { "if-match": etag } });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe("version_conflict");

    const audit = await call("GET", `/v1/audit?entityType=account&entityId=${accountA}`, { as: "owner@a.test", account: accountA });
    expect(audit.status).toBe(200);
    expect(audit.body.items[0]).toMatchObject({ action: "account.updated", actor: { email: "owner@a.test" } });
  });

  it("validates request bodies", async () => {
    const res = await call("PATCH", "/v1/account", { as: "owner@a.test", account: accountA, body: { horizonMonths: 0 }, headers: { "if-match": '"1"' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");
    expect(res.body.errors[0].path).toContain("horizonMonths");
  });

  it("editors can read but not change settings or members", async () => {
    const inv = await call("POST", "/v1/account/invitations", { as: "owner@a.test", account: accountA, body: { email: "editor@a.test", role: "editor" } });
    expect(inv.status).toBe(201);

    const me = await call("GET", "/v1/me", { as: "editor@a.test" });
    expect(me.body.accounts[0].roles).toEqual(["editor"]);

    const get = await call("GET", "/v1/account", { as: "editor@a.test", account: accountA });
    expect(get.status).toBe(200);
    const patch = await call("PATCH", "/v1/account", { as: "editor@a.test", account: accountA, body: { name: "X" }, headers: { "if-match": get.headers.etag as string } });
    expect(patch.status).toBe(403);
    const invite = await call("POST", "/v1/account/invitations", { as: "editor@a.test", account: accountA, body: { email: "x@a.test", role: "editor" } });
    expect(invite.status).toBe(403);
  });

  it("paginates the audit log with an opaque cursor", async () => {
    const first = await call("GET", "/v1/audit?limit=1", { as: "owner@a.test", account: accountA });
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await call("GET", `/v1/audit?limit=1&cursor=${first.body.nextCursor}`, { as: "owner@a.test", account: accountA });
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });
});
