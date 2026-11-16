import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Building2, CircleAlert, DoorOpen, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConflictDialog } from "@/components/conflict-dialog";
import { Field, PageHeader } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { etagOf, isConflict, type Location, unwrap } from "../api.js";
import { useApp } from "../AppContext.js";
import { useLocations } from "../queries.js";

type Draft = { id?: string; version?: number; kind: "venue" | "space"; parentId: string | null; name: string; address: string; lat: string; lng: string };

const toDraft = (l: Location): Draft => ({
  id: l.id, version: l.version, kind: l.kind, parentId: l.parentId, name: l.name, address: l.address ?? "",
  lat: l.geo ? String(l.geo.lat) : "", lng: l.geo ? String(l.geo.lng) : "",
});

/** Venues with their spaces (two levels, docs/mvp.md). Create and edit in a sheet; archive instead of delete. */
export function Locations() {
  const { t } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState(false);
  const query = useLocations(true);
  const all = query.data ?? [];
  const visible = all.filter((l) => showArchived || !l.archived);
  const venues = visible.filter((l) => l.kind === "venue");

  const refresh = () => qc.invalidateQueries({ queryKey: ["locations", accountId] });

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const geo = d.lat.trim() && d.lng.trim() ? { lat: Number(d.lat), lng: Number(d.lng) } : null;
      const fields = { name: d.name, address: d.address.trim() || null, geo };
      if (d.id) {
        return unwrap(await api.PATCH("/v1/locations/{id}", { params: { path: { id: d.id } }, body: fields, headers: { "If-Match": etagOf(d.version!) } }));
      }
      return unwrap(await api.POST("/v1/locations", { body: { ...fields, kind: d.kind, parentId: d.parentId } }));
    },
    onSuccess: () => {
      setDraft(null);
      toast.success(t("common.saved"));
      void refresh();
    },
    onError: (e) => isConflict(e) && setConflict(true),
  });

  const archive = useMutation({
    mutationFn: async ({ l, archived }: { l: Location; archived: boolean }) =>
      unwrap(await api.PATCH("/v1/locations/{id}", { params: { path: { id: l.id } }, body: { archived }, headers: { "If-Match": etagOf(l.version) } })),
    onSuccess: () => void refresh(),
    onError: (e) => isConflict(e) && setConflict(true),
  });

  const error = (!isConflict(save.error) && save.error) || (!isConflict(archive.error) && archive.error);

  const row = (l: Location, indent: boolean) => (
    <li key={l.id} className={`flex items-center gap-3 px-4 py-2.5 ${indent ? "pl-11" : ""}`}>
      {l.kind === "venue" ? <Building2 className="size-4 text-muted-foreground" /> : <DoorOpen className="size-4 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <div className={`truncate ${l.kind === "venue" ? "font-medium" : ""}`}>{l.name}</div>
        {l.address && <div className="truncate text-xs text-muted-foreground">{l.address}</div>}
      </div>
      {l.archived && <Badge variant="outline">{t("locations.archived")}</Badge>}
      {l.kind === "venue" && !l.archived && (
        <Button variant="ghost" size="sm" onClick={() => setDraft({ kind: "space", parentId: l.id, name: "", address: "", lat: "", lng: "" })}>
          <Plus /> {t("locations.addSpace")}
        </Button>
      )}
      <Button variant="ghost" size="icon" aria-label={`${t("common.edit")} ${l.name}`} onClick={() => setDraft(toDraft(l))}>
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`${l.archived ? t("locations.restore") : t("locations.archive")} ${l.name}`}
        disabled={archive.isPending}
        onClick={() => archive.mutate({ l, archived: !l.archived })}
      >
        {l.archived ? <ArchiveRestore /> : <Archive />}
      </Button>
    </li>
  );

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={t("locations.title")}
        description={t("locations.description")}
        actions={
          <Button onClick={() => setDraft({ kind: "venue", parentId: null, name: "", address: "", lat: "", lng: "" })}>
            <Plus /> {t("locations.addVenue")}
          </Button>
        }
      />
      <div className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        <div className="flex items-center gap-2">
          <Switch id="show-archived" checked={showArchived} onCheckedChange={setShowArchived} />
          <Label htmlFor="show-archived">{t("locations.showArchived")}</Label>
        </div>
        <div className="overflow-hidden rounded-lg border">
          {venues.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{query.isLoading ? "…" : t("locations.empty")}</p>
          ) : (
            <ul className="divide-y">
              {venues.map((v) => [row(v, false), ...visible.filter((s) => s.parentId === v.id).map((s) => row(s, true))])}
            </ul>
          )}
        </div>
      </div>

      <Sheet open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <SheetContent>
          {draft && (
            <form
              className="flex h-full flex-col"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(draft);
              }}
            >
              <SheetHeader>
                <SheetTitle>
                  {draft.id ? t("locations.edit") : draft.kind === "venue" ? t("locations.addVenue") : t("locations.addSpace")}
                </SheetTitle>
                {draft.kind === "space" && draft.parentId && (
                  <SheetDescription>{t("locations.inVenue", { venue: all.find((l) => l.id === draft.parentId)?.name })}</SheetDescription>
                )}
              </SheetHeader>
              <div className="grid gap-4 px-4">
                <Field label={t("locations.name")} htmlFor="loc-name">
                  <Input id="loc-name" required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </Field>
                <Field label={t("locations.address")} htmlFor="loc-address">
                  <Input id="loc-address" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("locations.lat")} htmlFor="loc-lat">
                    <Input id="loc-lat" inputMode="decimal" value={draft.lat} onChange={(e) => setDraft({ ...draft, lat: e.target.value })} />
                  </Field>
                  <Field label={t("locations.lng")} htmlFor="loc-lng">
                    <Input id="loc-lng" inputMode="decimal" value={draft.lng} onChange={(e) => setDraft({ ...draft, lng: e.target.value })} />
                  </Field>
                </div>
              </div>
              <SheetFooter>
                <Button type="submit" disabled={save.isPending}>{t("common.save")}</Button>
              </SheetFooter>
            </form>
          )}
        </SheetContent>
      </Sheet>
      <ConflictDialog
        open={conflict}
        onOpenChange={setConflict}
        onReload={() => {
          setDraft(null);
          void refresh();
        }}
      />
    </div>
  );
}
