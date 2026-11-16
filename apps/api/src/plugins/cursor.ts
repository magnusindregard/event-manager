import { HttpProblem } from "./problem.js";

// Opaque keyset cursors (ADR 0007): base64url JSON. Clients pass them back unchanged.

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(cursor: string | undefined, valid: (v: unknown) => v is T): T | undefined {
  if (!cursor) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (valid(v)) return v;
  } catch {
    /* fall through */
  }
  throw new HttpProblem(400, "invalid_cursor", "cursor is not a value from a previous response");
}

export const isString = (v: unknown): v is string => typeof v === "string";

/** Cursor over (startUtc, id), as used by occurrence lists. */
export const isTimeCursor = (v: unknown): v is { s: string; id: string } =>
  typeof v === "object" && v !== null && typeof (v as { s: unknown }).s === "string" && typeof (v as { id: unknown }).id === "string" &&
  !Number.isNaN(Date.parse((v as { s: string }).s));

/** Fetch limit + 1 rows; this trims the extra one and returns the cursor for the next page. */
export function page<T>(rows: T[], limit: number, cursorOf: (last: T) => unknown): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(cursorOf(items[items.length - 1]!)) : null };
}
