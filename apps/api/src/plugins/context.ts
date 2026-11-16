import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { type Db, type Tx, withTenant } from "@event-manager/db";
import { type ActorContext, DomainError, tenancy } from "@event-manager/domain";
import { AuthError, type TokenVerifier, type VerifiedIdentity } from "../auth.js";
import { HttpProblem } from "./problem.js";

declare module "fastify" {
  interface FastifyRequest {
    identity?: VerifiedIdentity & { userId: string };
    actor?: ActorContext;
  }
  interface FastifyInstance {
    db: Db;
    /** preHandler: requires a valid staff token. */
    authenticate: (req: FastifyRequest) => Promise<void>;
    /** Like authenticate, but always runs tenancy.login so new invitations apply at once. */
    authenticateFresh: (req: FastifyRequest) => Promise<void>;
    /** preHandler: requires a token plus membership of the account in the Account-Id header. */
    requireAccount: (req: FastifyRequest) => Promise<void>;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runs fn in a transaction scoped to the request's tenant, with the actor context. */
export function inTenant<T>(app: FastifyInstance, req: FastifyRequest, fn: (tx: Tx, ctx: ActorContext) => Promise<T>): Promise<T> {
  const ctx = req.actor;
  if (!ctx) throw new Error("inTenant used on a route without requireAccount");
  return withTenant(app.db, ctx, (tx) => fn(tx, ctx));
}

export const contextPlugin = fp(async (app: FastifyInstance, opts: { db: Db; verifier: TokenVerifier }) => {
  app.decorate("db", opts.db);

  // tenancy.login upserts the user and accepts invitations. Cache it briefly so every
  // request does not write. GET /v1/me (the admin's first call after sign-in) bypasses
  // the cache, so a fresh invitation applies on the next page load.
  const logins = new Map<string, { userId: string; until: number }>();
  const LOGIN_TTL_MS = 60_000;

  const authenticate = async (req: FastifyRequest, fresh: boolean) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new AuthError("Missing bearer token");
    const identity = await opts.verifier.verify(header.slice(7));
    const key = `${identity.issuer}|${identity.subject}`;
    let cached = logins.get(key);
    if (fresh || !cached || cached.until < Date.now()) {
      cached = { userId: await tenancy.login(opts.db, identity), until: Date.now() + LOGIN_TTL_MS };
      logins.set(key, cached);
      if (logins.size > 10_000) logins.clear();
    }
    req.identity = { ...identity, userId: cached.userId };
  };
  app.decorate("authenticate", (req: FastifyRequest) => authenticate(req, false));
  app.decorate("authenticateFresh", (req: FastifyRequest) => authenticate(req, true));

  app.decorate("requireAccount", async (req: FastifyRequest) => {
    await app.authenticate(req);
    const accountId = req.headers["account-id"];
    if (typeof accountId !== "string" || !UUID.test(accountId)) {
      throw new HttpProblem(400, "account_id_required", "Account-Id header with an account UUID is required");
    }
    const userId = req.identity!.userId;
    const roles = await withTenant(opts.db, { tenantId: accountId, userId }, (tx) => tenancy.rolesInTenant(tx, userId));
    // Same answer for "no such account" and "not a member": do not reveal which accounts exist.
    if (roles.length === 0) throw new DomainError("forbidden", "Not a member of this account");
    req.actor = { tenantId: accountId, userId, clientId: null, roles };
  });
});
