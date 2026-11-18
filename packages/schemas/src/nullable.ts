import { type Static, type TSchema, Type } from "typebox";

const PRIMITIVES = new Set(["string", "number", "integer", "boolean"]);

/**
 * A value or null. The APIs coerce types (Ajv coerceTypes), and Ajv coerces 0, "" and false to
 * null, or null to 0 and "", depending on which anyOf branch it tries first. A primitive is
 * therefore one schema with type [T, "null"]: Ajv coerces only when no listed type matches, so
 * 0 stays 0 and null stays null. Objects and arrays are never coerced to or from null; they stay
 * an anyOf with null first, so null is not wrapped into an array.
 */
export function Nullable<T extends TSchema>(t: T) {
  const type = (t as { type?: unknown }).type;
  if (typeof type === "string" && PRIMITIVES.has(type)) return Type.Unsafe<Static<T> | null>({ ...t, type: [type, "null"] });
  return Type.Union([Type.Null(), t]);
}
