import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Tx } from "@event-manager/db";

// Envelope encryption for sensitive columns (ADR 0003, 0004: per-tenant keys). Each tenant
// has a random 256-bit data key, stored in platform.data_key wrapped by a master key that
// never enters the database: in Azure a Key Vault secret passed to the apps as
// SENSITIVE_DATA_KEYS. Values are encrypted with AES-256-GCM, with a context string bound in
// as additional data (tenant, row and field), so a ciphertext copied to another row does not
// decrypt. Used by registration (sensitive answers) and integrations (OAuth tokens).
//
// SENSITIVE_DATA_KEYS is "id:base64key[,id:base64key…]". The first key wraps new data keys;
// the others only unwrap, so a master key can be rotated by adding a new one first and
// rewrapping (rewrapDataKey) before the old one is removed.

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface MasterKeys {
  currentId: string;
  keys: Map<string, Buffer>;
}

/** Local and test stacks only; refused when NODE_ENV=production. */
const DEV_KEYS = "dev:ZGV2LW9ubHktc2Vuc2l0aXZlLWRhdGEta2V5LTMyYnk=";

let configured: MasterKeys | null = null;

/** Parses SENSITIVE_DATA_KEYS. Throws on malformed input. */
export function parseMasterKeys(spec: string): MasterKeys {
  const keys = new Map<string, Buffer>();
  let currentId: string | null = null;
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const id = part.slice(0, i);
    const key = Buffer.from(part.slice(i + 1), "base64");
    if (i < 1 || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error("SENSITIVE_DATA_KEYS: each key is id:base64");
    if (key.length !== 32) throw new Error(`SENSITIVE_DATA_KEYS: key ${id} must be 32 bytes`);
    if (keys.has(id)) throw new Error(`SENSITIVE_DATA_KEYS: duplicate id ${id}`);
    keys.set(id, key);
    currentId ??= id;
  }
  if (!currentId) throw new Error("SENSITIVE_DATA_KEYS is empty");
  return { currentId, keys };
}

/** Sets the master keys explicitly (tests, or an app that reads them elsewhere). */
export function configureMasterKeys(spec: string): void {
  configured = parseMasterKeys(spec);
}

function masterKeys(): MasterKeys {
  if (configured) return configured;
  const spec = process.env.SENSITIVE_DATA_KEYS;
  if (!spec) {
    if (process.env.NODE_ENV === "production") throw new Error("SENSITIVE_DATA_KEYS is required to store or read sensitive data");
    configured = parseMasterKeys(DEV_KEYS);
  } else {
    configured = parseMasterKeys(spec);
  }
  return configured;
}

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), body]);
}

function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== VERSION) throw new Error("Unknown ciphertext format");
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(sealed.subarray(1 + IV_BYTES + TAG_BYTES)), d.final()]);
}

const wrapAad = (tenantId: string) => `data-key:${tenantId}`;

/** Per transaction: data keys already unwrapped, so a list of values unwraps once. */
const cache = new WeakMap<Tx, Map<string, Buffer>>();

/** The tenant's data key, created on first use. */
async function dataKey(tx: Tx, tenantId: string, create: boolean): Promise<Buffer | null> {
  const hit = cache.get(tx)?.get(tenantId);
  if (hit) return hit;
  const mk = masterKeys();
  let row = await tx.selectFrom("platform.data_key").select(["wrapped", "master_key_id"]).where("tenant_id", "=", tenantId).executeTakeFirst();
  if (!row) {
    if (!create) return null;
    const key = randomBytes(32);
    await tx.insertInto("platform.data_key")
      .values({ tenant_id: tenantId, wrapped: seal(mk.keys.get(mk.currentId)!, key, wrapAad(tenantId)), master_key_id: mk.currentId })
      .onConflict((oc) => oc.column("tenant_id").doNothing())
      .execute();
    row = await tx.selectFrom("platform.data_key").select(["wrapped", "master_key_id"]).where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  }
  const master = mk.keys.get(row.master_key_id);
  if (!master) throw new Error(`Master key ${row.master_key_id} is not configured`);
  const key = open(master, row.wrapped, wrapAad(tenantId));
  if (!cache.has(tx)) cache.set(tx, new Map());
  cache.get(tx)!.set(tenantId, key);
  return key;
}

/**
 * Encrypts a JSON value under the tenant's data key, creating the key on first use. `aad`
 * names where the value lives (e.g. "answer:<tenant>:<registration>:<field>") and must be
 * given again to decrypt it.
 */
export async function encryptJson(tx: Tx, tenantId: string, aad: string, value: unknown): Promise<Buffer> {
  const key = (await dataKey(tx, tenantId, true))!;
  return seal(key, Buffer.from(JSON.stringify(value), "utf8"), aad);
}

/** Decrypts a value from encryptJson with the same `aad`. */
export async function decryptJson(tx: Tx, tenantId: string, aad: string, ciphertext: Buffer): Promise<unknown> {
  const key = await dataKey(tx, tenantId, false);
  if (!key) throw new Error("The account has no data key");
  return JSON.parse(open(key, ciphertext, aad).toString("utf8"));
}

/** Rewraps the tenant's data key under the current master key; true if it changed. */
export async function rewrapDataKey(tx: Tx, tenantId: string): Promise<boolean> {
  const mk = masterKeys();
  const row = await tx.selectFrom("platform.data_key").select("master_key_id").where("tenant_id", "=", tenantId).forUpdate().executeTakeFirst();
  if (!row || row.master_key_id === mk.currentId) return false;
  const key = (await dataKey(tx, tenantId, false))!;
  await tx.updateTable("platform.data_key")
    .set({ wrapped: seal(mk.keys.get(mk.currentId)!, key, wrapAad(tenantId)), master_key_id: mk.currentId, updated_at: new Date() })
    .where("tenant_id", "=", tenantId).execute();
  return true;
}
