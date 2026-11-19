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

/** An event's rules, in resolution order. Shared by the rules tab and the schedule's source chips. */
export function useEventRules(eventId: string) {
  const { api, accountId } = useApp();
  return useQuery({
    queryKey: ["rules", accountId, eventId],
    queryFn: async () => unwrap(await api.GET("/v1/events/{id}/rules", { params: { path: { id: eventId } } })).items,
  });
}

export function useVatClasses() {
  const { api, accountId } = useApp();
  return useQuery({
    queryKey: ["vat-classes", accountId],
    queryFn: async () => unwrap(await api.GET("/v1/vat-classes")).items,
  });
}

/** The account's sales channels, active first. */
export function useSalesChannels() {
  const { api, accountId } = useApp();
  return useQuery({
    queryKey: ["sales-channels", accountId],
    queryFn: async () => unwrap(await api.GET("/v1/sales-channels")).items,
  });
}

/** The shop's product per (VAT class, channel). */
export function useSkuMappings() {
  const { api, accountId } = useApp();
  return useQuery({
    queryKey: ["sku-mappings", accountId],
    queryFn: async () => unwrap(await api.GET("/v1/sku-mappings")).items,
  });
}

/** A ticketed event's offers, in display order. */
export function useEventOffers(eventId: string, enabled = true) {
  const { api, accountId } = useApp();
  return useQuery({
    queryKey: ["offers", accountId, eventId],
    enabled,
    queryFn: async () => unwrap(await api.GET("/v1/events/{id}/offers", { params: { path: { id: eventId } } })).items,
  });
}

/** Offer name in the UI language, then the first name, then the code. */
export function offerName(offer: { code: string; translations: Record<string, { name: string }> } | undefined, language: string): string {
  if (!offer) return "…";
  return offer.translations[language]?.name ?? Object.values(offer.translations)[0]?.name ?? offer.code;
}
