import { DomainError } from "../shared/index.js";

/** Postgres error with a SQLSTATE code, as thrown by pg. */
export function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

export function notFound(entity: string): DomainError {
  return new DomainError("not_found", `${entity} not found`);
}

export function versionConflict(entity: string, currentVersion: number | undefined): DomainError {
  return new DomainError("version_conflict", `${entity} was changed by someone else`, currentVersion === undefined ? undefined : { currentVersion });
}

export function invalid(field: string, message: string): DomainError {
  return new DomainError("validation_failed", message, { field });
}

const URL_RE = /^https?:\/\/\S+$/;
export function assertUrl(field: string, v: string | null | undefined): void {
  if (v != null && !URL_RE.test(v)) throw invalid(field, "Must be an http(s) URL");
}

/** URL-safe slug, Norwegian letters transliterated. */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
  return s || "event";
}

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
