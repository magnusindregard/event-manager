import { createCoreClient, type paths } from "@event-manager/sdk";
import type { Auth } from "./auth/types.js";

let currentAccountId: string | null = null;
export const setCurrentAccountId = (id: string | null) => {
  currentAccountId = id;
};

export function createApi(auth: Auth) {
  return createCoreClient({
    baseUrl: import.meta.env.VITE_API_BASE_URL ?? "",
    getToken: () => auth.getToken(),
    getAccountId: () => currentAccountId,
  });
}
export type Api = ReturnType<typeof createApi>;

type Json<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { responses: { 200: { content: { "application/json": infer T } } } } ? T : never;
export type Me = Json<"/v1/me", "get">;
export type Account = Json<"/v1/account", "get">;
export type MembersResponse = Json<"/v1/account/members", "get">;
export type AuditPage = Json<"/v1/audit", "get">;

/** RFC 9457 problem from the API, thrown by the query helpers. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export function unwrap<T>(r: { data?: T; error?: unknown; response: Response }): T {
  if (r.error !== undefined || r.data === undefined) {
    const p = (r.error ?? {}) as { code?: string; title?: string; details?: { field?: string }; errors?: { path: string }[] };
    const field = p.details?.field ?? p.errors?.[0]?.path.replace(/^\/?body\//, "");
    throw new ApiProblem(r.response.status, p.code ?? "unknown", p.title ?? r.response.statusText, field);
  }
  return r.data;
}

export type Location = Json<"/v1/locations/{id}", "get">;
export type CatalogEvent = Json<"/v1/events/{id}", "get">;
export type EventSummary = Json<"/v1/events", "get">["items"][number];
export type Occurrence = Json<"/v1/occurrences/{id}", "get">;
export type Series = Json<"/v1/series/{id}", "get">;
export type SeriesChangeResult = Json<"/v1/series/{id}", "patch">;
export type TagVocabulary = Json<"/v1/tag-vocabularies", "get">["items"][number];
export type Tag = TagVocabulary["tags"][number];
export type ApiKey = Json<"/v1/api-keys", "get">["items"][number];

/** ETag for a resource version, as sent in If-Match. */
export const etagOf = (version: number) => `"${version}"`;

export const isConflict = (e: unknown) => e instanceof ApiProblem && e.code === "version_conflict";
