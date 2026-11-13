import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./core.js";
import type { components } from "./core.js";

export type { components, paths };
export type Schemas = components["schemas"];

export interface CoreClientOptions {
  baseUrl: string;
  /** Returns a fresh access token for each request. */
  getToken: () => Promise<string>;
  /** Returns the account the request acts on, if any (sent as Account-Id). */
  getAccountId?: () => string | null;
}

/** Typed client for the core API (/v1), generated from the OpenAPI document (ADR 0007). */
export function createCoreClient(opts: CoreClientOptions) {
  const client = createClient<paths>({ baseUrl: opts.baseUrl });
  const auth: Middleware = {
    async onRequest({ request }) {
      request.headers.set("authorization", `Bearer ${await opts.getToken()}`);
      const accountId = opts.getAccountId?.();
      if (accountId) request.headers.set("account-id", accountId);
      return request;
    },
  };
  client.use(auth);
  return client;
}

export type CoreClient = ReturnType<typeof createCoreClient>;
