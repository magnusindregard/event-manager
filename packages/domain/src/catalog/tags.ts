import { newId, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, recordAudit } from "../tenancy/index.js";
import { invalid, notFound, pgCode, versionConflict } from "./shared.js";

// Account-defined tag vocabularies (category, audience, language…). Configuring them is an
// account setting (owner); assigning tags to events is content (editor).

export type Labels = Record<string, string>;

export interface Tag {
  id: string;
  vocabularyId: string;
  key: string;
  labels: Labels;
  archived: boolean;
  version: number;
}

export interface TagVocabulary {
  id: string;
  key: string;
  labels: Labels;
  version: number;
  tags: Tag[];
}

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function assertKey(key: string) {
  if (!KEY_RE.test(key)) throw invalid("key", "Use lowercase letters, digits, - and _");
}

export async function listVocabularies(tx: Tx): Promise<TagVocabulary[]> {
  const [vocabs, tags] = await Promise.all([
    tx.selectFrom("tenancy.tag_vocabulary").select(["id", "key", "labels", "version"]).orderBy("key").execute(),
    tx.selectFrom("tenancy.tag").select(["id", "vocabulary_id", "key", "labels", "archived_at", "version"]).orderBy("key").execute(),
  ]);
  return vocabs.map((v) => ({
    id: v.id,
    key: v.key,
    labels: v.labels,
    version: v.version,
    tags: tags
      .filter((t) => t.vocabulary_id === v.id)
      .map((t) => ({ id: t.id, vocabularyId: t.vocabulary_id, key: t.key, labels: t.labels, archived: t.archived_at !== null, version: t.version })),
  }));
}

export async function createVocabulary(tx: Tx, ctx: ActorContext, input: { key: string; labels: Labels }): Promise<TagVocabulary> {
  assertCan(ctx, "account.write");
  assertKey(input.key);
  try {
    const row = await tx
      .insertInto("tenancy.tag_vocabulary")
      .values({ id: newId(), tenant_id: ctx.tenantId, key: input.key, labels: JSON.stringify(input.labels) })
      .returning(["id", "key", "labels", "version"])
      .executeTakeFirstOrThrow();
    await recordAudit(tx, ctx, { action: "tag_vocabulary.created", entityType: "tag_vocabulary", entityId: row.id, diff: input });
    await emit(tx, ctx.tenantId, { type: "tag_vocabulary.changed.v1", subject: `tag_vocabulary/${row.id}`, data: { id: row.id } });
    return { ...row, tags: [] };
  } catch (e) {
    if (pgCode(e) === "23505") throw new DomainError("conflict", "A vocabulary with this key exists", { field: "key" });
    throw e;
  }
}

export async function updateVocabulary(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, patch: { labels: Labels }): Promise<void> {
  assertCan(ctx, "account.write");
  const res = await tx
    .updateTable("tenancy.tag_vocabulary")
    .set({ labels: JSON.stringify(patch.labels), version: sql<number>`version + 1` })
    .where("id", "=", id)
    .where("version", "=", expectedVersion)
    .executeTakeFirst();
  if (!res.numUpdatedRows) {
    const exists = await tx.selectFrom("tenancy.tag_vocabulary").select("version").where("id", "=", id).executeTakeFirst();
    throw exists ? versionConflict("Vocabulary", exists.version) : notFound("Vocabulary");
  }
  await recordAudit(tx, ctx, { action: "tag_vocabulary.updated", entityType: "tag_vocabulary", entityId: id, diff: patch });
  await emit(tx, ctx.tenantId, { type: "tag_vocabulary.changed.v1", subject: `tag_vocabulary/${id}`, data: { id } });
}

export async function createTag(tx: Tx, ctx: ActorContext, vocabularyId: string, input: { key: string; labels: Labels }): Promise<Tag> {
  assertCan(ctx, "account.write");
  assertKey(input.key);
  const vocab = await tx.selectFrom("tenancy.tag_vocabulary").select("id").where("id", "=", vocabularyId).executeTakeFirst();
  if (!vocab) throw notFound("Vocabulary");
  try {
    const row = await tx
      .insertInto("tenancy.tag")
      .values({ id: newId(), tenant_id: ctx.tenantId, vocabulary_id: vocabularyId, key: input.key, labels: JSON.stringify(input.labels) })
      .returning(["id", "vocabulary_id", "key", "labels", "version"])
      .executeTakeFirstOrThrow();
    await recordAudit(tx, ctx, { action: "tag.created", entityType: "tag", entityId: row.id, diff: { vocabularyId, ...input } });
    await emit(tx, ctx.tenantId, { type: "tag.changed.v1", subject: `tag/${row.id}`, data: { id: row.id } });
    return { id: row.id, vocabularyId: row.vocabulary_id, key: row.key, labels: row.labels, archived: false, version: row.version };
  } catch (e) {
    if (pgCode(e) === "23505") throw new DomainError("conflict", "A tag with this key exists in the vocabulary", { field: "key" });
    throw e;
  }
}

export async function updateTag(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  expectedVersion: number,
  patch: { labels?: Labels; archived?: boolean },
): Promise<Tag> {
  assertCan(ctx, "account.write");
  const row = await tx
    .updateTable("tenancy.tag")
    .set({
      ...(patch.labels ? { labels: JSON.stringify(patch.labels) } : {}),
      ...(patch.archived !== undefined ? { archived_at: patch.archived ? sql<Date>`coalesce(archived_at, now())` : null } : {}),
      version: sql<number>`version + 1`,
    })
    .where("id", "=", id)
    .where("version", "=", expectedVersion)
    .returning(["id", "vocabulary_id", "key", "labels", "archived_at", "version"])
    .executeTakeFirst();
  if (!row) {
    const exists = await tx.selectFrom("tenancy.tag").select("version").where("id", "=", id).executeTakeFirst();
    throw exists ? versionConflict("Tag", exists.version) : notFound("Tag");
  }
  await recordAudit(tx, ctx, { action: "tag.updated", entityType: "tag", entityId: id, diff: patch });
  await emit(tx, ctx.tenantId, { type: "tag.changed.v1", subject: `tag/${id}`, data: { id } });
  return { id: row.id, vocabularyId: row.vocabulary_id, key: row.key, labels: row.labels, archived: row.archived_at !== null, version: row.version };
}

/** Tags assigned to events and occurrence overrides must exist and be active. */
export async function assertUsableTags(tx: Tx, ids: readonly string[], field: string): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await tx.selectFrom("tenancy.tag").select(["id", "archived_at"]).where("id", "in", unique).execute();
  if (rows.length !== unique.length) throw invalid(field, "Unknown tag");
  if (rows.some((r) => r.archived_at)) throw invalid(field, "Tag is archived");
}
