import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { type Location, type Tag, type TagVocabulary, unwrap } from "./api.js";
import { useApp } from "./AppContext.js";

// Shared queries. Keys start with the account id so switching accounts never mixes data.

export function useAccount() {
  const { api, accountId } = useApp();
  return useQuery({
    queryKey: ["account", accountId],
    queryFn: async () => {
      const r = await api.GET("/v1/account");
      return { account: unwrap(r), etag: r.response.headers.get("etag") ?? "" };
    },
  });
}

export function useLocations(includeArchived = false) {
  const { api, accountId } = useApp();
  return useQuery({
    queryKey: ["locations", accountId, includeArchived],
    queryFn: async () => unwrap(await api.GET("/v1/locations", { params: { query: { includeArchived } } })).items,
  });
}

export function useVocabularies() {
  const { api, accountId } = useApp();
  return useQuery({
    queryKey: ["tag-vocabularies", accountId],
    queryFn: async () => unwrap(await api.GET("/v1/tag-vocabularies")).items,
  });
}

/** Label in the UI language, then any label, then the key. */
export function useLabel() {
  const { i18n } = useTranslation();
  return (item: { key: string; labels: Record<string, string> }) =>
    item.labels[i18n.language] ?? Object.values(item.labels)[0] ?? item.key;
}

/** Tag id → "Vocabulary: Tag" for pickers and chips. */
export function useTagLabels(vocabs: TagVocabulary[] | undefined) {
  const label = useLabel();
  const map = new Map<string, { tag: Tag; text: string }>();
  for (const v of vocabs ?? []) for (const t of v.tags) map.set(t.id, { tag: t, text: `${label(v)}: ${label(t)}` });
  return map;
}

/** Location id → "Venue › Space". */
export function locationPath(locations: Location[] | undefined) {
  const byId = new Map((locations ?? []).map((l) => [l.id, l]));
  return (id: string | null | undefined) => {
    if (!id) return "";
    const l = byId.get(id);
    if (!l) return "…";
    const parent = l.parentId ? byId.get(l.parentId) : undefined;
    return parent ? `${parent.name} › ${l.name}` : l.name;
  };
}
