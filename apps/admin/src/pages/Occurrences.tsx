import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CircleAlert, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
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
import { type CatalogEvent, etagOf, isConflict, type Occurrence, unwrap } from "../api.js";
import { useApp } from "../AppContext.js";
import { locationPath, useLocations, useTagLabels, useVocabularies } from "../queries.js";

type Draft = {
  occ: Occurrence | null;
  startUtc: string;
  endUtc: string;
  locationOverrideId: string | null;
  externalUrlOverride: string;
  overrideTags: boolean;
  tagsOverride: string[];
};

function nextHour(): string {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/** One-off occurrences of an event, with effective values and where they come from. Series arrive in milestone 3. */
export function Occurrences({ event }: { event: CatalogEvent }) {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const locations = useLocations(true);
  const path = locationPath(locations.data);
  const tagLabels = useTagLabels(useVocabularies().data);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toDelete, setToDelete] = useState<Occurrence | null>(null);
  const [conflict, setConflict] = useState(false);

  const key = ["occurrences", accountId, event.id];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => unwrap(await api.GET("/v1/events/{id}/occurrences", { params: { path: { id: event.id }, query: { limit: 500 } } })).items,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["events", accountId] });
  };
  const onError = (e: Error) => isConflict(e) && setConflict(true);

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const overrides = {
        locationOverrideId: d.locationOverrideId,
        externalUrlOverride: d.externalUrlOverride.trim() || null,
        tagsOverride: d.overrideTags ? d.tagsOverride : null,
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
    onError,
  });

  const error = [save.error, setStatus.error, remove.error].find((e) => e && !isConflict(e));
  const fmt = (iso: string) => formatInZone(iso, event.timezone, i18n.language);
  const archived = event.status === "archived";

  const open = (o: Occurrence | null) => {
    const start = o?.startUtc ?? nextHour();
    setDraft({
      occ: o,
      startUtc: start,
      endUtc: o?.endUtc ?? new Date(new Date(start).getTime() + event.defaultDurationMin * 60_000).toISOString(),
      locationOverrideId: o?.overrides.locationId ?? null,
      externalUrlOverride: o?.overrides.externalUrl ?? "",
      overrideTags: o?.overrides.tagIds != null,
      tagsOverride: o?.overrides.tagIds ?? event.tagIds,
    });
  };

  const columns: ColumnDef<Occurrence>[] = [
    {
      id: "when",
      header: t("occurrences.when"),
      cell: ({ row }) => (
        <div className="whitespace-nowrap">
          <div className={row.original.status === "cancelled" ? "line-through" : ""}>{fmt(row.original.startUtc)}</div>
          <div className="text-xs text-muted-foreground">→ {fmt(row.original.endUtc)}</div>
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
            <SourceChip source={e?.source} />
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
            <SourceChip source={e?.source} />
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
            {e?.source === "override" && <SourceChip source="override" />}
          </div>
        );
      },
    },
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("occurrences.timesIn", { tz: event.timezone })}</p>
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
      <DataTable columns={columns} data={query.data ?? []} loading={query.isLoading} empty={t("occurrences.empty")} getRowId={(r) => r.id} />

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
                    value={draft.locationOverrideId}
                    onChange={(v) => setDraft({ ...draft, locationOverrideId: v })}
                    noneLabel={t("occurrences.inherit", { value: path(event.defaultLocationId) || "—" })}
                  />
                </Field>
                <Field label={t("occurrences.link")} htmlFor="occ-url" hint={t("occurrences.inherit", { value: event.externalUrl ?? "—" })}>
                  <Input id="occ-url" type="url" value={draft.externalUrlOverride} onChange={(e) => setDraft({ ...draft, externalUrlOverride: e.target.value })} />
                </Field>
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
            <AlertDialogDescription>{t("occurrences.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("conflict.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => toDelete && remove.mutate(toDelete)}>{t("common.delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={refresh} />
    </div>
  );
}
