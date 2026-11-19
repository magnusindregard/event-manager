import { DomainError } from "../shared/index.js";

// Sales windows (docs/ticketing.md, "Offer"): when an offer is on sale at an occurrence. Each
// bound is relative to the occurrence's start or absolute, like the registration window. No
// opening bound: on sale as soon as the event is published. No closing bound: until the start.
// Sales never run past the start, so an absolute close after it closes at the start.

export interface SalesWindowSettings {
  onSaleMinBefore: number | null;
  onSaleAt: Date | null;
  offSaleMinBefore: number | null;
  offSaleAt: Date | null;
}

export interface SalesWindow {
  /** Null: on sale as soon as the event is published. */
  opensAt: Date | null;
  closesAt: Date;
}

const MIN = 60_000;
const MAX_MINUTES = 525_600;

/** Pure: the window at one occurrence. */
export function salesWindow(startUtc: Date, w: SalesWindowSettings): SalesWindow {
  const start = startUtc.getTime();
  const opensAt = w.onSaleAt ?? (w.onSaleMinBefore === null ? null : new Date(start - w.onSaleMinBefore * MIN));
  const close = w.offSaleAt ? w.offSaleAt.getTime() : start - (w.offSaleMinBefore ?? 0) * MIN;
  return { opensAt, closesAt: new Date(Math.min(close, start)) };
}

/** Pure: whether the window is open at `now`. */
export const windowOpen = (w: SalesWindow, now: Date): boolean => (w.opensAt === null || now >= w.opensAt) && now < w.closesAt;

const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });

function minutes(field: string, v: number | null) {
  if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_MINUTES)) throw invalid(field, `Must be a whole number of minutes, 0–${MAX_MINUTES}`);
}

export type SalesWindowPatch = { [K in keyof SalesWindowSettings]?: SalesWindowSettings[K] | string | null };

const toDate = (field: string, v: Date | string | null | undefined): Date | null | undefined => {
  if (v === undefined || v === null || v instanceof Date) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw invalid(field, "Must be a date-time");
  return d;
};

/**
 * Applies a patch to stored settings and validates the result. Setting one form of a bound
 * clears the other (an absolute opening replaces a relative one); giving both is an error.
 */
export function applyWindowPatch(before: SalesWindowSettings, patch: SalesWindowPatch): SalesWindowSettings {
  const onSaleAt = toDate("onSaleAt", patch.onSaleAt);
  const offSaleAt = toDate("offSaleAt", patch.offSaleAt);
  const pair = <T, U>(rel: number | null | undefined, abs: T | null | undefined, relBefore: number | null, absBefore: U | null, field: string) => {
    if (rel != null && abs != null) throw invalid(field, "Give the time relative to the start or as a date, not both");
    if (rel != null) return { rel, abs: null };
    if (abs != null) return { rel: null, abs };
    return { rel: rel === null ? null : relBefore, abs: abs === null ? null : absBefore };
  };
  const on = pair(patch.onSaleMinBefore as number | null | undefined, onSaleAt, before.onSaleMinBefore, before.onSaleAt, "onSaleAt");
  const off = pair(patch.offSaleMinBefore as number | null | undefined, offSaleAt, before.offSaleMinBefore, before.offSaleAt, "offSaleAt");
  const w: SalesWindowSettings = { onSaleMinBefore: on.rel, onSaleAt: on.abs as Date | null, offSaleMinBefore: off.rel, offSaleAt: off.abs as Date | null };
  minutes("onSaleMinBefore", w.onSaleMinBefore);
  minutes("offSaleMinBefore", w.offSaleMinBefore);
  if (w.onSaleMinBefore !== null && w.onSaleMinBefore <= (w.offSaleMinBefore ?? 0) && w.offSaleAt === null) {
    throw invalid("onSaleMinBefore", "Sales must open before they close");
  }
  if (w.onSaleAt && w.offSaleAt && w.onSaleAt >= w.offSaleAt) throw invalid("onSaleAt", "Sales must open before they close");
  return w;
}

export const NO_WINDOW: SalesWindowSettings = { onSaleMinBefore: null, onSaleAt: null, offSaleMinBefore: null, offSaleAt: null };
