import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { CircleAlert, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { LocationSelect } from "@/components/catalog-fields";
import { type ColumnDef, DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page";
import { formatInZone } from "@/components/zoned-datetime";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type EventSummary, unwrap } from "../api.js";
import { useApp } from "../AppContext.js";
import { useTagLabels, useVocabularies } from "../queries.js";

export const STATUSES = ["draft", "published", "cancelled", "archived"] as const;
type Status = (typeof STATUSES)[number];
const ALL = "__all";

export function statusVariant(s: string): "default" | "secondary" | "outline" | "destructive" {
  return s === "published" ? "default" : s === "cancelled" ? "destructive" : s === "archived" ? "outline" : "secondary";
}

/** Title in the UI language, falling back to any translation. */
export function eventTitle(e: { slug: string; translations: Record<string, { title: string }> }, language: string): string {
  return e.translations[language]?.title ?? Object.values(e.translations)[0]?.title ?? e.slug;
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function Events() {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status | typeof ALL>(ALL);
  const [tagId, setTagId] = useState<string>(ALL);
  const [locationId, setLocationId] = useState<string | null>(null);
  const search = useDebounced(q.trim());
  const vocabs = useVocabularies();
  const tagLabels = useTagLabels(vocabs.data);

  const filters = { q: search || undefined, status: status === ALL ? undefined : [status], tagId: tagId === ALL ? undefined : tagId, locationId: locationId ?? undefined };
  const query = useInfiniteQuery({
    queryKey: ["events", accountId, filters],
    initialPageParam: undefined as string | undefined,
    placeholderData: keepPreviousData,
    queryFn: async ({ pageParam }) =>
      unwrap(await api.GET("/v1/events", { params: { query: { ...filters, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];

  const columns: ColumnDef<EventSummary>[] = [
    {
      id: "title",
      header: t("events.title"),
      cell: ({ row }) => (
        <Link to={`/events/${row.original.id}`} className="font-medium underline-offset-4 hover:underline">
          {eventTitle(row.original, i18n.language)}
          <span className="block text-xs font-normal text-muted-foreground">/{row.original.slug}</span>
        </Link>
      ),
    },
    { id: "status", header: t("events.status"), cell: ({ row }) => <Badge variant={statusVariant(row.original.status)}>{t(`events.statuses.${row.original.status}`)}</Badge> },
    {
      id: "next",
      header: t("events.next"),
      cell: ({ row }) =>
        row.original.nextStartUtc ? (
          <span className="whitespace-nowrap">{formatInZone(row.original.nextStartUtc, row.original.timezone, i18n.language)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { id: "count", header: t("events.occurrences"), cell: ({ row }) => row.original.occurrenceCount },
    {
      id: "tags",
      header: t("events.tags"),
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.tagIds.map((id) => <Badge key={id} variant="outline" className="font-normal">{tagLabels.get(id)?.text ?? "…"}</Badge>)}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("events.listTitle")}
        actions={
          <Button asChild>
            <Link to="/events/new"><Plus /> {t("events.new")}</Link>
          </Button>
        }
      />
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Input aria-label={t("common.search")} placeholder={t("common.search")} value={q} onChange={(e) => setQ(e.target.value)} />
          <Select value={status} onValueChange={(v) => setStatus(v as Status)}>
            <SelectTrigger aria-label={t("events.status")} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("events.allStatuses")}</SelectItem>
              {STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`events.statuses.${s}`)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={tagId} onValueChange={setTagId}>
            <SelectTrigger aria-label={t("events.tags")} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("events.allTags")}</SelectItem>
              {[...tagLabels.entries()].map(([id, l]) => <SelectItem key={id} value={id}>{l.text}</SelectItem>)}
            </SelectContent>
          </Select>
          <LocationSelect id="filter-location" value={locationId} onChange={setLocationId} noneLabel={t("events.allLocations")} />
        </div>
        {query.isError && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{t("error.generic")}</AlertDescription>
          </Alert>
        )}
        <DataTable columns={columns} data={rows} loading={query.isLoading} empty={t("events.empty")} getRowId={(r) => r.id} />
        {query.hasNextPage && (
          <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {t("audit.loadMore")}
          </Button>
        )}
      </div>
    </div>
  );
}
