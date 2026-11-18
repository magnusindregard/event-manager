import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./core.js";
import type { components } from "./core.js";

export type { components, paths };
export type Schemas = components["schemas"];

export interface CoreClientOptions {
  baseUrl: string;
  /** Returns a fresh access token for each request. */
  getToken: () => Promise<string>;
  /**
   * Returns the account the request acts on, if any (sent as Account-Id). Read synchronously when
   * the request starts, before the token is awaited, so a request stays bound to the account that
   * was selected when it was made even if the selection changes while the token is refreshed.
   */
  getAccountId?: () => string | null;
}

/** Typed client for the core API (/v1), generated from the OpenAPI document (ADR 0007). */
export function createCoreClient(opts: CoreClientOptions) {
  const client = createClient<paths>({ baseUrl: opts.baseUrl });
  const auth: Middleware = {
    async onRequest({ request }) {
      // Bind the tenant before the first await (openapi-fetch runs this middleware synchronously
      // from the call), so switching accounts during token acquisition cannot redirect it.
      const accountId = opts.getAccountId?.();
      const token = await opts.getToken();
      request.headers.set("authorization", `Bearer ${token}`);
      if (accountId) request.headers.set("account-id", accountId);
      return request;
    },
  };
  client.use(auth);
  return client;
}

export type CoreClient = ReturnType<typeof createCoreClient>;

import type { paths as publicPaths, components as publicComponents } from "./public.js";
export type { publicPaths, publicComponents };
export type PublicSchemas = publicComponents["schemas"];

export interface PublicClientOptions {
  /** e.g. https://<front door host> */
  baseUrl: string;
  /** Publishable key (pk_…), sent as ?key= so edge caches keep tenants apart. */
  publishableKey?: string;
  /** Preview token (prv_…) for CMS previews. Server-side only. */
  previewToken?: string;
}

/** Typed client for the public read API (/public/v1). */
export function createPublicClient(opts: PublicClientOptions) {
  const client = createClient<publicPaths>({ baseUrl: opts.baseUrl });
  client.use({
    onRequest({ request }) {
      if (opts.previewToken) {
        request.headers.set("authorization", `Bearer ${opts.previewToken}`);
        return request;
      }
      if (!opts.publishableKey) return request;
      const url = new URL(request.url);
      url.searchParams.set("key", opts.publishableKey);
      return new Request(url, request);
    },
  });
  return client;
}

export type PublicClient = ReturnType<typeof createPublicClient>;

import type { paths as attendeePaths, components as attendeeComponents } from "./attendee.js";
export type { attendeePaths, attendeeComponents };
export type AttendeeSchemas = attendeeComponents["schemas"];

/** Typed client for the attendee API (/attendee/v1). Pass the manage token for /registration. */
export function createAttendeeClient(opts: { baseUrl: string; manageToken?: string }) {
  const client = createClient<attendeePaths>({ baseUrl: opts.baseUrl });
  if (opts.manageToken) {
    const token = opts.manageToken;
    client.use({ onRequest({ request }) { request.headers.set("authorization", `Bearer ${token}`); return request; } });
  }
  return client;
}

export type AttendeeClient = ReturnType<typeof createAttendeeClient>;
