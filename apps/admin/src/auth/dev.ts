import { SignJWT } from "jose";
import type { Auth, AuthUser } from "./types.js";

// Local development only: mints HS256 tokens the API accepts when AUTH_DEV_SECRET is set.
// The API refuses dev tokens when NODE_ENV=production.
const KEY = "em.devUser";
const secret = new TextEncoder().encode(import.meta.env.VITE_AUTH_DEV_SECRET ?? "");

function load(): AuthUser | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function createDevAuth(onChange: () => void): Auth {
  let user = load();
  return {
    ready: true,
    get user() {
      return user;
    },
    async signIn(email) {
      if (!email) throw new Error("email required");
      user = { email, name: email.split("@")[0] ?? null };
      try {
        localStorage.setItem(KEY, JSON.stringify(user));
      } catch {
        /* private mode */
      }
      onChange();
    },
    async signOut() {
      user = null;
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
      onChange();
    },
    async getToken() {
      if (!user) throw new Error("not signed in");
      return new SignJWT({ email: user.email, name: user.name })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("urn:event-manager:dev")
        .setSubject(user.email)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(secret);
    },
  };
}
