import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { tenancy } from "@event-manager/domain";

export type VerifiedIdentity = tenancy.VerifiedIdentity;

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

export class AuthError extends Error {}

function identityFrom(payload: JWTPayload): VerifiedIdentity {
  // Entra External ID: email comes from the optional `email` claim (configure it on
  // the app registration); preferred_username is the fallback.
  const email = (payload.email ?? payload.preferred_username) as string | undefined;
  if (!payload.iss || !payload.sub || !email) throw new AuthError("Token is missing iss, sub or email");
  return { issuer: payload.iss, subject: payload.sub, email, name: (payload.name as string | undefined) ?? null };
}

/** Verifies access tokens from the managed IdP (ADR 0012: Entra External ID) against its JWKS. */
export function oidcVerifier(opts: { issuer: string; audience: string }): TokenVerifier {
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  const getJwks = async () => {
    if (!jwks) {
      const res = await fetch(new URL(".well-known/openid-configuration", opts.issuer.endsWith("/") ? opts.issuer : `${opts.issuer}/`));
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      const doc = (await res.json()) as { jwks_uri: string };
      jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
    }
    return jwks;
  };
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, await getJwks(), { issuer: opts.issuer, audience: opts.audience });
        return identityFrom(payload);
      } catch (e) {
        if (e instanceof AuthError) throw e;
        throw new AuthError(e instanceof Error ? e.message : "Invalid token");
      }
    },
  };
}

export const DEV_ISSUER = "urn:event-manager:dev";

/** Local development and tests only: HS256 tokens signed with a shared secret. */
export function devVerifier(secret: string): TokenVerifier {
  const key = new TextEncoder().encode(secret);
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, { issuer: DEV_ISSUER, algorithms: ["HS256"] });
        return identityFrom(payload);
      } catch (e) {
        if (e instanceof AuthError) throw e;
        throw new AuthError(e instanceof Error ? e.message : "Invalid token");
      }
    },
  };
}

/** Tries each verifier in turn; used locally when both dev and OIDC are configured. */
export function anyVerifier(verifiers: TokenVerifier[]): TokenVerifier {
  return {
    async verify(token) {
      let last: unknown;
      for (const v of verifiers) {
        try {
          return await v.verify(token);
        } catch (e) {
          last = e;
        }
      }
      throw last instanceof Error ? last : new AuthError("Invalid token");
    },
  };
}
