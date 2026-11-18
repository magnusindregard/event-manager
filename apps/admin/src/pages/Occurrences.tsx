import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CalendarDays, CircleAlert, List, Pencil, Plus, Repeat, RotateCcw, SquarePen, Trash2, TriangleAlert, Undo2, Users, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LocationSelect, SourceChip, TagPicker } from "@/components/catalog-fields";
import { ConflictDialog } from "@/components/conflict-dialog";
import { type ColumnDef, DataTable } from "@/components/data-table";
import { Field } from "@/components/page";
import { formatInZone, ZonedDateTimeField } from "@/components/zoned-datetime";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiProblem, type CatalogEvent, etagOf, isConflict, type Occurrence, type Series, unwrap } from "../api.js";
import { useApp } from "../AppContext.js";
import { describeRule, slotsBefore } from "../lib/recurrence.js";
import { locationPath, useEventRules, useLocations, useTagLabels, useVocabularies } from "../queries.js";
import { useRuleRefresh } from "./Rules.js";
import { BulkOverride } from "./schedule/BulkOverride.js";
import { EMPTY_FILTER, filterOccurrences, isFiltering, OccurrenceFilter, type OccurrenceFilterValue } from "./schedule/OccurrenceFilter.js";
import { RuleEditor, type RuleEditorMode } from "./schedule/RuleEditor.js";
import { OccurrenceCalendar } from "./schedule/OccurrenceCalendar.js";
import { type EditorMode, RecurrenceEditor } from "./schedule/RecurrenceEditor.js";
import { Registrations } from "./schedule/Registrations.js";

type Draft = {
  occ: Occurrence | null;
  startUtc: string;
  endUtc: string;
  locationOverrideId: string | null;
  /** No location for this occurrence, whatever the event and its rules say. */
  locationCleared: boolean;
  externalUrlOverride: string;
  externalUrlCleared: boolean;
  overrideTags: boolean;
  tagsOverride: string[];
  /** Empty: follow the event and its rules. */
  capacityOverride: string;
};

function nextHour(): string {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/**
 * An event's schedule: its series, and every occurrence with effective values and where they
 * come from. Series occurrences follow Outlook: edit this one (detaches it), this and
 * following (splits the series), or the entire series.
 */
export function Occurrences({ event }: { event: CatalogEvent }) {
  const { t, i18n } = useTranslation();
  const { api, accountId, can } = useApp();
  const qc = useQueryClient();
  const locations = useLocations(true);
  const path = locationPath(locations.data);
  const tagLabels = useTagLabels(useVocabularies().data);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toDelete, setToDelete] = useState<Occurrence | null>(null);
  const [registrationsOf, setRegistrationsOf] = useState<Occurrence | null>(null);
  const [conflict, setConflict] = useState(false);
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const [seriesToDelete, setSeriesToDelete] = useState<Series | null>(null);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [filter, setFilter] = useState<OccurrenceFilterValue>(EMPTY_FILTER);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [ruleEditor, setRuleEditor] = useState<RuleEditorMode | null>(null);
  const rules = useEventRules(event.id).data ?? [];
  const ruleName = (id: string | null | undefined) => rules.find((r) => r.id === id)?.name;
  const registration = event.admissionMode === "registration";
  const ruleRefresh = useRuleRefresh(event.id);

  const key = ["occurrences", accountId, event.id];
  const seriesKey = ["series", accountId, event.id];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      // Every occurrence (an open-ended daily series has ~550 in 18 months), a page at a time.
      const all: Occurrence[] = [];
      let cursor: string | undefined;
      do {
        const page = unwrap(await api.GET("/v1/events/{id}/occurrences", { params: { path: { id: event.id }, query: { limit: 500, cursor } } }));
        all.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && all.length < 10_000);
      return all;
    },
  });
  const seriesQuery = useQuery({
    queryKey: seriesKey,
    queryFn: async () => unwrap(await api.GET("/v1/events/{id}/series", { params: { path: { id: event.id } } })).items,
  });
  const seriesById = new Map((seriesQuery.data ?? []).map((s) => [s.id, s]));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: seriesKey });
    void qc.invalidateQueries({ queryKey: ["events", accountId] });
    void qc.invalidateQueries({ queryKey: ["audit", accountId] });
  };
  const onError = (e: Error) => isConflict(e) && setConflict(true);
  /**
   * Conflict dialog's Reload: drop every form and confirmation that holds the stale version, fetch
   * the latest, and reopen the occurrence that was being edited with its current values and version.
   */
  const reload = async () => {
    const editing = draft?.occ?.id;
    setDraft(null);
    setToDelete(null);
    setSeriesToDelete(null);
    refresh();
    await qc.refetchQueries({ queryKey: key });
    const latest = editing && qc.getQueryData<Occurrence[]>(key)?.find((o) => o.id === editing);
    if (latest) open(latest);
  };
  const visible = filterOccurrences(query.data ?? [], filter, event.timezone, locations.data ?? []);
  const chosen = visible.filter((o) => selected.has(o.id));
  const setChosen = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) if (on) next.add(id); else next.delete(id);
    setSelected(next);
  };

  const bulkStatus = useMutation({
    mutationFn: async (status: "scheduled" | "cancelled") =>
      unwrap(await api.POST("/v1/events/{id}/occurrences/bulk-update", {
        params: { path: { id: event.id } },
        body: { items: chosen.filter((o) => o.status !== status).map((o) => ({ id: o.id, version: o.version })), set: { status } },
      })),
    onSuccess: (r, status) => {
      toast.success(t(status === "cancelled" ? "bulk.cancelled" : "bulk.reinstated", { count: r.items.length }));
      setSelected(new Set());
      refresh();
    },
    onError,
  });

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const overrides = {
        locationOverrideId: d.locationCleared ? null : d.locationOverrideId,
        locationOverrideCleared: d.locationCleared,
        externalUrlOverride: d.externalUrlCleared ? null : d.externalUrlOverride.trim() || null,
        externalUrlOverrideCleared: d.externalUrlCleared,
        tagsOverride: d.overrideTags ? d.tagsOverride : null,
        ...(registration ? { capacityOverride: d.capacityOverride.trim() === "" ? null : Number(d.capacityOverride) } : {}),
      };
      if (d.occ) {
        return unwrap(await api.PATCH("/v1/occurrences/{id}", {
          params: { path: { id: d.occ.id } },
          body: { ...overrides, startUtc: d.startUtc, endUtc: d.endUtc },
          headers: { "If-Match": etagOf(d.occ.version) },
        }));
      }
      return unwrap(await api.POST("/v1/events/{id}/occurrences", {
        params: { path: { id: event.id } },
        body: { ...overrides, startUtc: d.startUtc, endUtc: d.endUtc },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }));
    },
    onSuccess: () => {
      setDraft(null);
      toast.success(t("common.saved"));
      refresh();
    },
    onError,
  });

  const setStatus = useMutation({
    mutationFn: async ({ o, status }: { o: Occurrence; status: "scheduled" | "cancelled" }) =>
      unwrap(await api.PATCH("/v1/occurrences/{id}", { params: { path: { id: o.id } }, body: { status }, headers: { "If-Match": etagOf(o.version) } })),
    onSuccess: refresh,
    onError,
  });

  const remove = useMutation({
    mutationFn: async (o: Occurrence) => {
      const r = await api.DELETE("/v1/occurrences/{id}", { params: { path: { id: o.id } }, headers: { "If-Match": etagOf(o.version) } });
      if (r.error) unwrap(r);
    },
    onSuccess: () => {
      setToDelete(null);
      refresh();
    },
    onError: (e: Error) => {
      if (e instanceof ApiProblem && e.code === "conflict") {
        setToDelete(null);
        toast.error(t("registrations.deleteBlocked"));
      } else onError(e);
    },
  });

  const settle = useMutation({
    mutationFn: async ({ o, how }: { o: Occurrence; how: "keep" | "reattach" }) => {
      const headers = { "If-Match": etagOf(o.version) };
      return how === "keep"
        ? unwrap(await api.PATCH("/v1/occurrences/{id}", { params: { path: { id: o.id } }, body: { conflict: false }, headers }))
        : unwrap(await api.POST("/v1/occurrences/{id}/reattach", { params: { path: { id: o.id } }, headers }));
    },
    onSuccess: () => {
      setDraft(null);
      refresh();
    },
    onError,
  });

  const removeSeries = useMutation({
    mutationFn: async (s: Series) => unwrap(await api.DELETE("/v1/series/{id}", { params: { path: { id: s.id } }, headers: { "If-Match": etagOf(s.version) } })),
    onSuccess: (r) => {
      setSeriesToDelete(null);
      toast.success(t("series.deletedSummary", { deleted: r.changes.counts.deleted, kept: r.changes.counts.unchanged }));
      refresh();
    },
    onError,
  });

  const error = [save.error, setStatus.error, remove.error, settle.error, removeSeries.error, bulkStatus.error].find((e) => e && !isConflict(e));
  const fmt = (iso: string) => formatInZone(iso, event.timezone, i18n.language);
  const archived = event.status === "archived";

  const open = (o: Occurrence | null) => {
    const start = o?.startUtc ?? nextHour();
    setDraft({
      occ: o,
      startUtc: start,
      endUtc: o?.endUtc ?? new Date(new Date(start).getTime() + event.defaultDurationMin * 60_000).toISOString(),
      locationOverrideId: o?.overrides.locationId ?? null,
      locationCleared: o?.overrides.locationCleared ?? false,
      externalUrlOverride: o?.overrides.externalUrl ?? "",
      externalUrlCleared: o?.overrides.externalUrlCleared ?? false,
      overrideTags: o?.overrides.tagIds != null,
      tagsOverride: o?.overrides.tagIds ?? event.tagIds,
      capacityOverride: o?.overrides.capacity == null ? "" : String(o.overrides.capacity),
    });
  };

  const allChosen = visible.length > 0 && chosen.length === visible.length;
  const placesColumn: ColumnDef<Occurrence> = {
    id: "places",
    header: t("occurrences.places"),
    cell: ({ row }) => {
      const p = row.original.pool;
      const e = row.original.effective.capacity;
      if (!p) return "—";
      return (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="tabular-nums">{p.bookableLimit === null ? t("occurrences.placesUnlimited", { taken: p.taken }) : t("occurrences.placesOf", { taken: p.taken + p.held, limit: p.bookableLimit })}</span>
          {p.overbookingPct > 0 && p.capacity !== null && <span className="text-muted-foreground">({t("occurrences.capacityPlus", { capacity: p.capacity, pct: p.overbookingPct })})</span>}
          {p.overLimit && <Badge variant="destructive">{t("occurrences.overLimit")}</Badge>}
          {e?.source !== "default" && <SourceChip source={e?.source} rule={ruleName(e?.ruleId)} />}
        </div>
      );
    },
  };
  const baseColumns: ColumnDef<Occurrence>[] = [
    {
      id: "select",
      header: () => (
        <Checkbox
          aria-label={t("bulk.selectAll")}
          checked={allChosen ? true : chosen.length ? "indeterminate" : false}
          disabled={archived || visible.length === 0}
          onCheckedChange={(v) => setChosen(visible.map((o) => o.id), v === true)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={`${t("bulk.select")} ${fmt(row.original.startUtc)}`}
          checked={selected.has(row.original.id)}
          disabled={archived}
          onCheckedChange={(v) => setChosen([row.original.id], v === true)}
        />
      ),
    },
    {
      id: "when",
      header: t("occurrences.when"),
      cell: ({ row }) => (
        <div className="whitespace-nowrap">
          <div className="flex items-center gap-1.5">
            {row.original.seriesId && <Repeat className="size-3.5 text-muted-foreground" aria-label={t("series.badge.series")} />}
            <span className={row.original.status === "cancelled" ? "line-through" : ""}>{fmt(row.original.startUtc)}</span>
          </div>
          <div className="text-xs text-muted-foreground">→ {fmt(row.original.endUtc)}</div>
          {(row.original.conflict || (row.original.seriesId && row.original.detached)) && (
            <div className="mt-1 flex gap-1">
              {row.original.conflict ? (
                <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400"><TriangleAlert /> {t("series.badge.conflict")}</Badge>
              ) : (
                <Badge variant="outline">{t("series.badge.detached")}</Badge>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      id: "location",
      header: t("occurrences.location"),
      cell: ({ row }) => {
        const e = row.original.effective.location;
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <span>{e?.value ? path(e.value) : "—"}</span>
            <SourceChip source={e?.source} rule={ruleName(e?.ruleId)} cleared={e?.value == null} />
          </div>
        );
      },
    },
    {
      id: "link",
      header: t("occurrences.link"),
      cell: ({ row }) => {
        const e = row.original.effective.externalUrl;
        return (
          <div className="flex max-w-48 flex-wrap items-center gap-1.5">
            <span className="block max-w-full truncate text-xs" title={e?.value ?? undefined}>{e?.value?.replace(/^https?:\/\//, "") ?? "—"}</span>
            <SourceChip source={e?.source} rule={ruleName(e?.ruleId)} cleared={e?.value == null} />
          </div>
        );
      },
    },
    {
      id: "tags",
      header: t("events.tags"),
      cell: ({ row }) => {
        const e = row.original.effective.tags;
        return (
          <div className="flex flex-wrap items-center gap-1">
            {(e?.value ?? []).map((id) => <Badge key={id} variant="outline" className="font-normal">{tagLabels.get(id)?.text ?? "…"}</Badge>)}
            {e?.source !== "default" && <SourceChip source={e?.source} rule={ruleName(e?.ruleId)} />}
          </div>
        );
      },
    },
    ...(registration ? [placesColumn] : []),
    {
      id: "status",
      header: t("events.status"),
      cell: ({ row }) => row.original.status === "cancelled" && <Badge variant="destructive">{t("occurrences.cancelled")}</Badge>,
    },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("common.actions")}</span>,
      cell: ({ row }) => {
        const o = row.original;
        const label = fmt(o.startUtc);
        return (
          <div className="flex justify-end">
            {registration && o.pool && can("registrations.read") && (
              <Button variant="ghost" size="icon" aria-label={t("registrations.openFor", { when: label })} onClick={() => setRegistrationsOf(o)}>
                <Users />
              </Button>
            )}
            <Button variant="ghost" size="icon" aria-label={`${t("common.edit")} ${label}`} disabled={archived} onClick={() => open(o)}>
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${o.status === "cancelled" ? t("occurrences.reinstate") : t("occurrences.cancel")} ${label}`}
              disabled={archived || setStatus.isPending}
              onClick={() => setStatus.mutate({ o, status: o.status === "cancelled" ? "scheduled" : "cancelled" })}
            >
              {o.status === "cancelled" ? <RotateCcw /> : <Ban />}
            </Button>
            <Button variant="ghost" size="icon" aria-label={`${t("common.delete")} ${label}`} disabled={archived} onClick={() => setToDelete(o)}>
              <Trash2 />
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <section aria-labelledby="series-heading" className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="series-heading" className="text-sm font-medium">{t("series.title")}</h2>
          <Button variant="outline" onClick={() => setEditor({ kind: "create" })} disabled={archived}>
            <Repeat /> {t("series.add")}
          </Button>
        </div>
        {(seriesQuery.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("series.empty")}</p>
        ) : (
          <ul className="grid gap-2">
            {seriesQuery.data!.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm">{describeRule(s.rrule, s.dtstartLocal, t, i18n.language)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("series.meta", { duration: s.durationMin, tz: s.timezone })}
                    {!s.complete && ` · ${t("series.generatedUntil", { date: new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: s.timezone }).format(new Date(s.generatedUntil)) })}`}
                  </p>
                </div>
                <div className="flex">
                  <Button variant="ghost" size="sm" disabled={archived} onClick={() => setEditor({ kind: "edit", series: s })}>
                    <Pencil /> {t("series.editAll")}
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={t("series.delete")} disabled={archived} onClick={() => setSeriesToDelete(s)}>
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <div className="flex items-center gap-3">
          <Tabs value={view} onValueChange={(v) => setView(v as "list" | "calendar")}>
            <TabsList>
              <TabsTrigger value="list"><List /> {t("series.view.list")}</TabsTrigger>
              <TabsTrigger value="calendar"><CalendarDays /> {t("series.view.calendar")}</TabsTrigger>
            </TabsList>
          </Tabs>
          <p className="text-sm text-muted-foreground">{t("occurrences.timesIn", { tz: event.timezone })}</p>
        </div>
        <Button onClick={() => open(null)} disabled={archived}>
          <Plus /> {t("occurrences.add")}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      <OccurrenceFilter
        value={filter}
        onChange={(f) => {
          setFilter(f);
          setSelected(new Set());
        }}
        onSaveAsRule={(conditions) => setRuleEditor({ kind: "create", conditions })}
        disabled={archived}
      />
      {(chosen.length > 0 || isFiltering(filter)) && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-3 py-2" role="region" aria-label={t("bulk.region")}>
          <span className="text-sm">
            {isFiltering(filter) && t("filter.showing", { count: visible.length, total: query.data?.length ?? 0 })}
            {isFiltering(filter) && chosen.length > 0 && " · "}
            {chosen.length > 0 && t("bulk.selected", { count: chosen.length })}
          </span>
          {chosen.length > 0 && (
            <div className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setBulkOpen(true)} disabled={archived}><SquarePen /> {t("bulk.override")}</Button>
              <Button size="sm" variant="outline" disabled={archived || bulkStatus.isPending || chosen.every((o) => o.status === "cancelled")} onClick={() => bulkStatus.mutate("cancelled")}>
                <Ban /> {t("occurrences.cancel")}
              </Button>
              <Button size="sm" variant="outline" disabled={archived || bulkStatus.isPending || chosen.every((o) => o.status === "scheduled")} onClick={() => bulkStatus.mutate("scheduled")}>
                <RotateCcw /> {t("occurrences.reinstate")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}><X /> {t("bulk.clear")}</Button>
            </div>
          )}
        </div>
      )}
      {view === "list" ? (
        <DataTable columns={baseColumns.filter((c) => !(registration && c.id === "link"))} data={visible} loading={query.isLoading} empty={isFiltering(filter) ? t("filter.none") : t("occurrences.empty")} getRowId={(r) => r.id} />
      ) : (
        <OccurrenceCalendar occurrences={visible} timezone={event.timezone} title={eventTitleShort(event, i18n.language)} onSelect={(o) => !archived && open(o)} />
      )}

      <Registrations
        event={event}
        occurrence={registrationsOf && (query.data?.find((o) => o.id === registrationsOf.id) ?? registrationsOf)}
        label={registrationsOf ? fmt(registrationsOf.startUtc) : ""}
        onClose={() => setRegistrationsOf(null)}
      />
      <Sheet open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <SheetContent className="sm:max-w-md">
          {draft && (
            <form
              className="flex h-full flex-col overflow-y-auto"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(draft);
              }}
            >
              <SheetHeader>
                <SheetTitle>{draft.occ ? t("occurrences.edit") : t("occurrences.add")}</SheetTitle>
                <SheetDescription>{t("occurrences.timesIn", { tz: event.timezone })}</SheetDescription>
              </SheetHeader>
              <div className="grid gap-4 px-4">
                {draft.occ?.seriesId && seriesById.get(draft.occ.seriesId) && (
                  <SeriesScope
                    occ={draft.occ}
                    series={seriesById.get(draft.occ.seriesId)!}
                    busy={settle.isPending}
                    onFollowing={(series, at) => {
                      setDraft(null);
                      setEditor({ kind: "split", series, at, slotsBefore: slotsBefore(series, query.data ?? [], at) });
                    }}
                    onAll={(series) => {
                      setDraft(null);
                      setEditor({ kind: "edit", series });
                    }}
                    onSettle={(how) => settle.mutate({ o: draft.occ!, how })}
                  />
                )}
                <Field label={t("occurrences.start")} htmlFor="occ-start">
                  <ZonedDateTimeField
                    id="occ-start"
                    label={t("occurrences.start")}
                    timezone={event.timezone}
                    value={draft.startUtc}
                    onChange={(startUtc) => {
                      const dur = new Date(draft.endUtc).getTime() - new Date(draft.startUtc).getTime();
                      setDraft({ ...draft, startUtc, endUtc: new Date(new Date(startUtc).getTime() + dur).toISOString() });
                    }}
                  />
                </Field>
                <Field label={t("occurrences.end")} htmlFor="occ-end">
                  <ZonedDateTimeField id="occ-end" label={t("occurrences.end")} timezone={event.timezone} value={draft.endUtc} onChange={(endUtc) => setDraft({ ...draft, endUtc })} />
                </Field>
                <h3 className="pt-2 text-sm font-medium">{t("occurrences.overrides")}</h3>
                <p className="-mt-2 text-xs text-muted-foreground">{t("occurrences.overridesHint")}</p>
                <Field label={t("occurrences.location")} htmlFor="occ-location">
                  <LocationSelect
                    id="occ-location"
                    value={draft.locationCleared ? null : draft.locationOverrideId}
                    onChange={(v) => setDraft({ ...draft, locationOverrideId: v })}
                    noneLabel={t("occurrences.inherit", { value: path(event.defaultLocationId) || "—" })}
                    disabled={draft.locationCleared}
                  />
                  <div className="flex items-center gap-2">
                    <Checkbox id="occ-location-cleared" checked={draft.locationCleared} onCheckedChange={(v) => setDraft({ ...draft, locationCleared: v === true })} />
                    <Label htmlFor="occ-location-cleared" className="font-normal">{t("occurrences.noLocation")}</Label>
                  </div>
                </Field>
                {!registration && (
                  <div className="grid gap-2">
                    <Field label={t("occurrences.link")} htmlFor="occ-url" hint={t("occurrences.inherit", { value: event.externalUrl ?? "—" })}>
                      <Input id="occ-url" type="url" value={draft.externalUrlCleared ? "" : draft.externalUrlOverride} disabled={draft.externalUrlCleared}
                        onChange={(e) => setDraft({ ...draft, externalUrlOverride: e.target.value })} />
                    </Field>
                    <div className="flex items-center gap-2">
                      <Checkbox id="occ-url-cleared" checked={draft.externalUrlCleared} onCheckedChange={(v) => setDraft({ ...draft, externalUrlCleared: v === true })} />
                      <Label htmlFor="occ-url-cleared" className="font-normal">{t("occurrences.noLink")}</Label>
                    </div>
                  </div>
                )}
                {registration && (
                  <Field label={t("occurrences.capacityOverride")} htmlFor="occ-capacity"
                    hint={t("occurrences.inherit", { value: event.registration.capacity ?? t("events.reg.unlimited") })}>
                    <Input id="occ-capacity" type="number" min={0} max={1000000} className="w-40" value={draft.capacityOverride}
                      onChange={(e) => setDraft({ ...draft, capacityOverride: e.target.value })} />
                  </Field>
                )}
                <div className="flex items-center gap-2">
                  <Checkbox id="occ-tags-override" checked={draft.overrideTags} onCheckedChange={(v) => setDraft({ ...draft, overrideTags: v === true })} />
                  <Label htmlFor="occ-tags-override">{t("occurrences.overrideTags")}</Label>
                </div>
                {draft.overrideTags && <TagPicker id="occ-tags" value={draft.tagsOverride} onChange={(v) => setDraft({ ...draft, tagsOverride: v })} />}
              </div>
              <SheetFooter>
                <Button type="submit" disabled={save.isPending}>{t("common.save")}</Button>
              </SheetFooter>
            </form>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("occurrences.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{toDelete?.seriesId ? t("series.deleteOccurrenceBody") : t("occurrences.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("conflict.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => toDelete && remove.mutate(toDelete)}>{t("common.delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!seriesToDelete} onOpenChange={(o) => !o && setSeriesToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("series.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("series.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("conflict.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => seriesToDelete && removeSeries.mutate(seriesToDelete)}>{t("common.delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RecurrenceEditor
        event={event}
        mode={editor}
        onClose={() => setEditor(null)}
        onSaved={() => {
          setEditor(null);
          refresh();
        }}
        onConflict={() => {
          setEditor(null);
          setConflict(true);
        }}
      />
      <BulkOverride
        event={event}
        occurrences={chosen}
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onSaved={() => {
          setBulkOpen(false);
          setSelected(new Set());
          refresh();
        }}
        onConflict={() => {
          setBulkOpen(false);
          setConflict(true);
        }}
      />
      <RuleEditor
        event={event}
        rules={rules}
        mode={ruleEditor}
        onClose={() => setRuleEditor(null)}
        onSaved={(r) => {
          setRuleEditor(null);
          setFilter(EMPTY_FILTER);
          ruleRefresh(r);
        }}
        onConflict={() => {
          setRuleEditor(null);
          setConflict(true);
        }}
      />
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => void reload()} />
    </div>
  );
}

const eventTitleShort = (e: CatalogEvent, language: string) => e.translations[language]?.title ?? Object.values(e.translations)[0]?.title ?? e.slug;

/** Outlook's choice for a series occurrence, plus how to settle a conflict. */
function SeriesScope({ occ, series, busy, onFollowing, onAll, onSettle }: {
  occ: Occurrence;
  series: Series;
  busy: boolean;
  onFollowing(series: Series, at: string): void;
  onAll(series: Series): void;
  onSettle(how: "keep" | "reattach"): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3">
      {occ.conflict && (
        <Alert className="border-amber-500">
          <TriangleAlert />
          <AlertDescription>
            <p>{t("series.conflictHelp")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onSettle("keep")}>{t("series.keep")}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onSettle("reattach")}><Undo2 /> {t("series.reattach")}</Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <Alert>
        <Repeat />
        <AlertDescription>
          <p>{occ.detached ? t("series.thisDetached") : t("series.thisOnly")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {occ.recurrenceIdLocal && (
              <Button type="button" size="sm" variant="outline" onClick={() => onFollowing(series, occ.recurrenceIdLocal!)}>{t("series.editFollowing")}</Button>
            )}
            <Button type="button" size="sm" variant="outline" onClick={() => onAll(series)}>{t("series.editAll")}</Button>
            {occ.detached && !occ.conflict && (
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onSettle("reattach")}><Undo2 /> {t("series.reattach")}</Button>
            )}
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}
