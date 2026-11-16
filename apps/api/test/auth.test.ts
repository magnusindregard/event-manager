import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import type { webcrypto } from "node:crypto";

type CryptoKey = webcrypto.CryptoKey;
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { oidcVerifier } from "../src/auth.js";

// Mimics an Entra External ID tenant: issuer https://<tid>.ciamlogin.com/<tid>/v2.0, with
// discovery at <issuer>/.well-known/openid-configuration pointing to a JWKS.
const TID = "11111111-2222-3333-4444-555555555555";
const AUDIENCE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"; // API client ID (v2 tokens)
let server: Server;
let issuer: string;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    res.setHeader("content-type", "application/json");
    if (req.url === `/${TID}/v2.0/.well-known/openid-configuration`) {
      res.end(JSON.stringify({ issuer: `${base}/${TID}/v2.0`, jwks_uri: `${base}/${TID}/discovery/v2.0/keys` }));
    } else if (req.url === `/${TID}/discovery/v2.0/keys`) {
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${TID}/v2.0`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const sign = (claims: JWTPayload, opts: { iss?: string; aud?: string; key?: CryptoKey } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? issuer)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject("sub-123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(opts.key ?? privateKey);

describe("oidcVerifier (External ID shaped)", () => {
  it("accepts a token from the tenant and maps the identity", async () => {
    const v = oidcVerifier({ issuer, audience: AUDIENCE });
    const id = await v.verify(await sign({ email: "Staff@Example.com", name: "Staff" }));
    expect(id).toEqual({ issuer, subject: "sub-123", email: "Staff@Example.com", name: "Staff" });
  });

  it("falls back to preferred_username when the email claim is missing", async () => {
    const v = oidcVerifier({ issuer, audience: AUDIENCE });
    const id = await v.verify(await sign({ preferred_username: "staff@example.com" }));
    expect(id.email).toBe("staff@example.com");
  });

  it("rejects tokens without any email", async () => {
    const v = oidcVerifier({ issuer, audience: AUDIENCE });
    await expect(v.verify(await sign({}))).rejects.toThrow(/email/);
  });

  it("rejects the wrong audience (e.g. the api:// URI instead of the client ID)", async () => {
    const v = oidcVerifier({ issuer, audience: AUDIENCE });
    await expect(v.verify(await sign({ email: "a@b.c" }, { aud: "api://em-api-staging" }))).rejects.toThrow();
  });

  it("rejects another issuer and a token signed with another key", async () => {
    const v = oidcVerifier({ issuer, audience: AUDIENCE });
    await expect(v.verify(await sign({ email: "a@b.c" }, { iss: "https://evil.example/v2.0" }))).rejects.toThrow();
    const other = await generateKeyPair("RS256");
    await expect(v.verify(await sign({ email: "a@b.c" }, { key: other.privateKey }))).rejects.toThrow();
  });
});
