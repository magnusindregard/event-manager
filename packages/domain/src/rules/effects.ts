import type { EffectiveField, TargetedField } from "@event-manager/db";
import { DomainError } from "../shared/index.js";

// Effect-type registry (docs/mvp.md, "Occurrence rules"). A rule effect is generic
// (effectType, targetRef, value); its type's handler validates the value, says which
// effective field it sets, which catalog entities it references, and how it turns the
// event default into the effective value. Targeted types (price, offerAvailable) set a field
// per target: their targetRef names it (an offer), and they resolve per (field, targetRef).

export interface EffectRefs {
  locations?: string[];
  tags?: string[];
  offers?: string[];
}

export interface EffectType<V = unknown> {
  type: string;
  field: EffectiveField | TargetedField;
  /** Whether the effect needs a targetRef, and what kind of entity it names. */
  targeted: boolean;
  target?: "offer";
  /** Returns the canonical value, or throws validation_failed. */
  validate(value: unknown, path: string): V;
  refs(value: V): EffectRefs;
  /** The field's effective value when this effect wins, given the event default. */
  apply(value: V, base: unknown): unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_RE = /^https?:\/\/\S+$/;

const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });

const uuidList = (v: unknown, path: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !UUID_RE.test(x))) throw invalid(path, "Must be a list of tag ids");
  if (v.length > 100) throw invalid(path, "At most 100 tags");
  // Postgres returns uuids in lowercase; case variants are the same tag (#43).
  return [...new Set((v as string[]).map((x) => x.toLowerCase()))].sort();
};

export interface TagsEffect {
  /** Added to the event's tags. */
  add: string[];
  /** Removed from the event's tags. */
  remove: string[];
}

const location: EffectType<string> = {
  type: "location",
  field: "location",
  targeted: false,
  validate(value, path) {
    if (typeof value !== "string" || !UUID_RE.test(value)) throw invalid(path, "Must be a location id");
    return value.toLowerCase();
  },
  refs: (v) => ({ locations: [v] }),
  apply: (v) => v,
};

const tags: EffectType<TagsEffect> = {
  type: "tags",
  field: "tags",
  targeted: false,
  validate(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(path, "Must be { add, remove }");
    const extra = Object.keys(value).filter((k) => k !== "add" && k !== "remove");
    if (extra.length) throw invalid(path, `Unknown property ${extra[0]}`);
    const v = value as { add?: unknown; remove?: unknown };
    const add = uuidList(v.add ?? [], `${path}.add`);
    const remove = uuidList(v.remove ?? [], `${path}.remove`);
    if (add.length + remove.length === 0) throw invalid(path, "Add or remove at least one tag");
    if (add.some((t) => remove.includes(t))) throw invalid(path, "A tag cannot be both added and removed");
    return { add, remove };
  },
  refs: (v) => ({ tags: [...v.add, ...v.remove] }),
  apply(v, base) {
    // Lowercase here too: rules saved before ids were normalized may hold uppercase ids.
    const out = new Set(Array.isArray(base) ? (base as string[]).map((t) => t.toLowerCase()) : []);
    for (const t of v.add) out.add(t.toLowerCase());
    for (const t of v.remove) out.delete(t.toLowerCase());
    return [...out].sort();
  },
};

const externalUrl: EffectType<string> = {
  type: "externalUrl",
  field: "externalUrl",
  targeted: false,
  validate(value, path) {
    if (typeof value !== "string" || !URL_RE.test(value) || value.length > 2000) throw invalid(path, "Must be an http(s) URL");
    return value;
  },
  refs: () => ({}),
  apply: (v) => v,
};

const intIn = (type: string, field: EffectiveField, min: number, max: number, message: string): EffectType<number> => ({
  type,
  field,
  targeted: false,
  validate(value, path) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw invalid(path, message);
    return value;
  },
  refs: () => ({}),
  apply: (v) => v,
});

const offerTarget = (ref: string, path: string) => {
  if (!UUID_RE.test(ref)) throw invalid(path, "Must be an offer id");
  return ref.toLowerCase();
};

/** The offer's price at matching occurrences, in minor units including VAT (docs/ticketing.md). */
const price: EffectType<{ amount: number }> = {
  type: "price",
  field: "price",
  targeted: true,
  target: "offer",
  validate(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(path, "Must be { amount }");
    const extra = Object.keys(value).filter((k) => k !== "amount");
    if (extra.length) throw invalid(path, `Unknown property ${extra[0]}`);
    const amount = (value as { amount?: unknown }).amount;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0 || amount > 100_000_000) {
      throw invalid(`${path}.amount`, "Must be a whole amount in minor units, 0–100000000");
    }
    return { amount };
  },
  refs: () => ({}),
  apply: (v) => v.amount,
};

/** false takes the offer off sale at matching occurrences. */
const offerAvailable: EffectType<boolean> = {
  type: "offerAvailable",
  field: "offerAvailable",
  targeted: true,
  target: "offer",
  validate(value, path) {
    if (typeof value !== "boolean") throw invalid(path, "Must be true or false");
    return value;
  },
  refs: () => ({}),
  apply: (v) => v,
};

/** Validates and normalizes a targetRef for the effect type. */
export function validateTarget(t: EffectType, ref: string, path: string): string {
  return t.target === "offer" ? offerTarget(ref, path) : ref;
}

/** Places per occurrence (docs/registration.md). */
const capacity = intIn("capacity", "capacity", 0, 1_000_000, "Must be a whole number of places, 0–1000000");
/** Overbooking in percent of capacity. */
const overbooking = intIn("overbooking", "overbooking", 0, 100, "Must be a whole percentage, 0–100");

const registry = new Map<string, EffectType>([location, tags, externalUrl, capacity, overbooking, price, offerAvailable].map((t) => [t.type, t as EffectType]));

export const EFFECT_TYPES: readonly string[] = [...registry.keys()];

export function effectType(type: string): EffectType {
  const t = registry.get(type);
  if (!t) throw new DomainError("validation_failed", `Unknown effect type ${type}`, { field: "effects" });
  return t;
}
