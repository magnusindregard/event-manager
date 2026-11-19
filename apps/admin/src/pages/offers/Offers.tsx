import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Combobox } from "@/components/combobox";
import { ConflictDialog } from "@/components/conflict-dialog";
import { type ColumnDef, DataTable } from "@/components/data-table";
import { Field } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { type CatalogEvent, etagOf, isConflict, type Offer, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { formatMoney, moneyInput, parseMoney } from "../../lib/money.js";
import { offerName, useAccount, useEventOffers, useVatClasses } from "../../queries.js";
import { eventTitle } from "../Events.js";

/** After an offer change: refresh offers and prices now, and again if the worker resolves them. */
export function useOfferRefresh(eventId: string) {
  const { accountId } = useApp();
  const qc = useQueryClient();
  return (resolution?: string) => {
    const run = () => {
      void qc.invalidateQueries({ queryKey: ["offers", accountId, eventId] });
      void qc.invalidateQueries({ queryKey: ["prices", accountId, eventId] });
      void qc.invalidateQueries({ queryKey: ["vat-classes", accountId] });
    };
    run();
    if (resolution === "queued") for (const ms of [3000, 8000]) setTimeout(run, ms);
  };
}

/** The ticket types a ticketed event sells, with default prices (docs/ticketing.md, "Offer"). */
export function Offers({ event }: { event: CatalogEvent }) {
  const { t, i18n } = useTranslation();
  const { api, can } = useApp();
  const query = useEventOffers(event.id);
  const vat = useVatClasses();
  const [editing, setEditing] = useState<Offer | "new" | null>(null);
  const [copying, setCopying] = useState(false);
  const [toDelete, setToDelete] = useState<Offer | null>(null);
  const [conflict, setConflict] = useState(false);
  const refresh = useOfferRefresh(event.id);
  const canWrite = can("offers.write") && event.status !== "archived";
  const vatLabel = (id: string) => {
    const v = vat.data?.find((x) => x.id === id);
    return v ? `${v.label} (${v.ratePct} %)` : "…";
  };

  const remove = useMutation({
    mutationFn: async (o: Offer) => {
      const r = await api.DELETE("/v1/offers/{id}", { params: { path: { id: o.id } }, headers: { "If-Match": etagOf(o.version) } });
      if (r.error) unwrap(r);
    },
    onSuccess: () => {
      setToDelete(null);
      toast.success(t("offers.deleted"));
      refresh();
    },
    onError: (e) => {
      setToDelete(null);
      if (isConflict(e)) setConflict(true);
    },
  });

  const columns: ColumnDef<Offer>[] = [
    {
      id: "name",
      header: t("offers.name"),
      cell: ({ row }) => (
        <div>
          <div className={row.original.status === "archived" ? "font-medium text-muted-foreground line-through" : "font-medium"}>{offerName(row.original, i18n.language)}</div>
          <code className="text-xs text-muted-foreground">{row.original.code}</code>
        </div>
      ),
    },
    { id: "price", header: t("offers.defaultPrice"), cell: ({ row }) => formatMoney(row.original.defaultPrice, i18n.language) },
    { id: "vat", header: t("offers.vatClass"), cell: ({ row }) => vatLabel(row.original.vatClassId) },
    {
      id: "places",
      header: t("offers.placesPerUnit"),
      cell: ({ row }) => (
        <span>
          {row.original.placesPerUnit}
          <span className="block text-xs text-muted-foreground">{t("offers.perReservation", { min: row.original.minPerReservation, max: row.original.maxPerReservation })}</span>
        </span>
      ),
    },
    { id: "status", header: t("offers.status"), cell: ({ row }) => <Badge variant={row.original.status === "active" ? "default" : "secondary"}>{t(`offers.statuses.${row.original.status}`)}</Badge> },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("common.actions")}</span>,
      cell: ({ row }) => canWrite && (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" aria-label={`${t("common.edit")} ${offerName(row.original, i18n.language)}`} onClick={() => setEditing(row.original)}><Pencil /></Button>
          <Button variant="ghost" size="icon" aria-label={`${t("common.delete")} ${offerName(row.original, i18n.language)}`} onClick={() => setToDelete(row.original)}><Trash2 /></Button>
        </div>
      ),
    },
  ];

  const noVat = vat.data && vat.data.filter((v) => !v.archived).length === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-prose text-sm text-muted-foreground">{t("offers.intro")}</p>
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setCopying(true)}><Copy /> {t("offers.copy")}</Button>
            <Button onClick={() => setEditing("new")} disabled={noVat}><Plus /> {t("offers.add")}</Button>
          </div>
        )}
      </div>
      {noVat && (
        <Alert>
          <CircleAlert />
          <AlertDescription>{t("offers.noVat")}</AlertDescription>
        </Alert>
      )}
      {remove.error && !isConflict(remove.error) && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}
      <DataTable columns={columns} data={query.data ?? []} loading={query.isLoading} empty={t("offers.empty")} getRowId={(o) => o.id} />

      <OfferEditor event={event} offer={editing} onClose={() => setEditing(null)} onSaved={(r) => { setEditing(null); refresh(r); }}
        onConflict={() => { setEditing(null); setConflict(true); }} />
      <CopyOffers event={event} open={copying} onClose={() => setCopying(false)} onCopied={(r) => { setCopying(false); refresh(r); }} />
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("offers.deleteTitle", { name: offerName(toDelete ?? undefined, i18n.language) })}</AlertDialogTitle>
            <AlertDialogDescription>{t("offers.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => toDelete && remove.mutate(toDelete)}>{t("common.delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => refresh()} />
    </div>
  );
}

type Draft = {
  code: string;
  vatClassId: string;
  price: string;
  placesPerUnit: string;
  min: string;
  max: string;
  active: boolean;
  translations: Record<string, { name: string; description: string }>;
};

const whole = (s: string, min: number, max: number) => /^\d+$/.test(s.trim()) && Number(s) >= min && Number(s) <= max;

function OfferEditor({ event, offer, onClose, onSaved, onConflict }: {
  event: CatalogEvent;
  offer: Offer | "new" | null;
  onClose(): void;
  onSaved(resolution: string): void;
  onConflict(): void;
}) {
  return (
    <Sheet open={!!offer} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-lg">
        {offer && <OfferForm key={offer === "new" ? "new" : `${offer.id}:${offer.version}`} event={event} offer={offer === "new" ? null : offer} onSaved={onSaved} onConflict={onConflict} />}
      </SheetContent>
    </Sheet>
  );
}

function OfferForm({ event, offer, onSaved, onConflict }: { event: CatalogEvent; offer: Offer | null; onSaved(resolution: string): void; onConflict(): void }) {
  const { t, i18n } = useTranslation();
  const { api } = useApp();
  const account = useAccount().data?.account;
  const vat = (useVatClasses().data ?? []).filter((v) => !v.archived || v.id === offer?.vatClassId);
  const locales = account?.locales ?? [];
  const [d, setD] = useState<Draft>(() => ({
    code: offer?.code ?? "",
    vatClassId: offer?.vatClassId ?? vat[0]?.id ?? "",
    price: moneyInput(offer?.defaultPrice, i18n.language),
    placesPerUnit: String(offer?.placesPerUnit ?? 1),
    min: String(offer?.minPerReservation ?? 1),
    max: String(offer?.maxPerReservation ?? 20),
    active: (offer?.status ?? "active") === "active",
    translations: Object.fromEntries((account?.locales ?? Object.keys(offer?.translations ?? {})).map((l) => [l, {
      name: offer?.translations[l]?.name ?? "", description: offer?.translations[l]?.description ?? "",
    }])),
  }));
  const price = parseMoney(d.price);
  const defaultLocale = account?.defaultLocale ?? "nb";
  const valid = price !== null && !!d.vatClassId && whole(d.placesPerUnit, 1, 100) && whole(d.min, 1, 1000) && whole(d.max, 1, 1000) &&
    Number(d.min) <= Number(d.max) && !!d.translations[defaultLocale]?.name.trim();

  const save = useMutation({
    mutationFn: async () => {
      const translations: Record<string, { name: string; description: string | null } | null> = {};
      for (const [l, tr] of Object.entries(d.translations)) {
        if (tr.name.trim()) translations[l] = { name: tr.name.trim(), description: tr.description.trim() || null };
        else if (offer?.translations[l]) translations[l] = null;
      }
      const fields = {
        vatClassId: d.vatClassId, defaultPrice: price!, placesPerUnit: Number(d.placesPerUnit), minPerReservation: Number(d.min), maxPerReservation: Number(d.max),
        ...(d.code.trim() ? { code: d.code.trim() } : {}),
      };
      if (!offer) {
        const named = Object.fromEntries(Object.entries(translations).filter((e): e is [string, { name: string; description: string | null }] => e[1] !== null));
        return unwrap(await api.POST("/v1/events/{id}/offers", { params: { path: { id: event.id } }, body: { ...fields, translations: named }, headers: { "Idempotency-Key": crypto.randomUUID() } }));
      }
      return unwrap(await api.PATCH("/v1/offers/{id}", {
        params: { path: { id: offer.id } }, body: { ...fields, status: d.active ? "active" : "archived", translations }, headers: { "If-Match": etagOf(offer.version) },
      }));
    },
    onSuccess: (r) => {
      toast.success(r.resolution === "queued" ? t("offers.savedQueued") : t("common.saved"));
      onSaved(r.resolution);
    },
    onError: (e) => isConflict(e) && onConflict(),
  });

  const setT = (l: string, patch: Partial<Draft["translations"][string]>) => setD({ ...d, translations: { ...d.translations, [l]: { ...d.translations[l]!, ...patch } } });

  return (
    <form className="flex h-full flex-col overflow-y-auto" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
      <SheetHeader>
        <SheetTitle>{offer ? t("offers.edit") : t("offers.add")}</SheetTitle>
        <SheetDescription>{t("offers.editorHint")}</SheetDescription>
      </SheetHeader>
      <div className="grid gap-4 px-4">
        <Tabs defaultValue={defaultLocale}>
          <TabsList>
            {locales.map((l) => <TabsTrigger key={l} value={l}>{l}{l === defaultLocale && " *"}</TabsTrigger>)}
          </TabsList>
          {locales.map((l) => (
            <TabsContent key={l} value={l} className="grid gap-3 pt-2">
              <Field label={t("offers.name")} htmlFor={`offer-name-${l}`}>
                <Input id={`offer-name-${l}`} value={d.translations[l]?.name ?? ""} maxLength={200} required={l === defaultLocale}
                  placeholder={t("offers.namePlaceholder")} onChange={(e) => setT(l, { name: e.target.value })} />
              </Field>
              <Field label={t("offers.description")} htmlFor={`offer-desc-${l}`}>
                <Textarea id={`offer-desc-${l}`} rows={2} maxLength={2000} value={d.translations[l]?.description ?? ""} onChange={(e) => setT(l, { description: e.target.value })} />
              </Field>
            </TabsContent>
          ))}
        </Tabs>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("offers.defaultPrice")} htmlFor="offer-price" hint={t("offers.priceHint")}>
            <Input id="offer-price" inputMode="decimal" required value={d.price} aria-invalid={d.price !== "" && price === null}
              onChange={(e) => setD({ ...d, price: e.target.value })} />
          </Field>
          <Field label={t("offers.vatClass")} htmlFor="offer-vat">
            <Select value={d.vatClassId} onValueChange={(v) => setD({ ...d, vatClassId: v })}>
              <SelectTrigger id="offer-vat" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {vat.map((v) => <SelectItem key={v.id} value={v.id}>{v.label} ({v.ratePct} %)</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("offers.placesPerUnit")} htmlFor="offer-places" hint={t("offers.placesHint")}>
            <Input id="offer-places" type="number" min={1} max={100} value={d.placesPerUnit} onChange={(e) => setD({ ...d, placesPerUnit: e.target.value })} />
          </Field>
          <Field label={t("offers.code")} htmlFor="offer-code" hint={offer ? t("offers.codeHintEdit") : t("offers.codeHint")}>
            <Input id="offer-code" value={d.code} pattern="[a-z0-9][a-z0-9_\-]*" maxLength={63} onChange={(e) => setD({ ...d, code: e.target.value.toLowerCase() })} />
          </Field>
          <Field label={t("offers.min")} htmlFor="offer-min">
            <Input id="offer-min" type="number" min={1} max={1000} value={d.min} onChange={(e) => setD({ ...d, min: e.target.value })} />
          </Field>
          <Field label={t("offers.max")} htmlFor="offer-max">
            <Input id="offer-max" type="number" min={1} max={1000} value={d.max} onChange={(e) => setD({ ...d, max: e.target.value })} />
          </Field>
        </div>
        {offer && (
          <div className="flex items-center gap-2">
            <Switch id="offer-active" checked={d.active} onCheckedChange={(v) => setD({ ...d, active: v })} />
            <span className="text-sm">{t("offers.activeLabel")}</span>
          </div>
        )}
        {save.error && !isConflict(save.error) && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{save.error.message}</AlertDescription>
          </Alert>
        )}
      </div>
      <SheetFooter>
        <Button type="submit" disabled={!valid || save.isPending}>{offer ? t("common.save") : t("offers.create")}</Button>
      </SheetFooter>
    </form>
  );
}

function CopyOffers({ event, open, onClose, onCopied }: { event: CatalogEvent; open: boolean; onClose(): void; onCopied(resolution: string): void }) {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const [from, setFrom] = useState("");
  const events = useQuery({
    queryKey: ["events", accountId, "ticketed"],
    enabled: open,
    queryFn: async () => unwrap(await api.GET("/v1/events", { params: { query: { limit: 200 } } })).items.filter((e) => e.admissionMode === "tickets" && e.id !== event.id),
  });
  const byId = new Map((events.data ?? []).map((e) => [e.id, e]));
  const copy = useMutation({
    mutationFn: async () => unwrap(await api.POST("/v1/events/{id}/offers/copy", { params: { path: { id: event.id } }, body: { fromEventId: from }, headers: { "Idempotency-Key": crypto.randomUUID() } })),
    onSuccess: (r) => {
      toast.success(t("offers.copied", { count: r.created.length }) + (r.skipped.length ? ` ${t("offers.copySkipped", { codes: r.skipped.join(", ") })}` : ""));
      setFrom("");
      onCopied(r.resolution);
    },
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("offers.copy")}</DialogTitle>
          <DialogDescription>{t("offers.copyHint")}</DialogDescription>
        </DialogHeader>
        <Combobox id="copy-from" options={[...byId.keys()]} value={from} onChange={setFrom} label={(id) => { const e = byId.get(id); return e ? eventTitle(e, i18n.language) : id; }}
          placeholder={t("offers.copyFrom")} searchPlaceholder={t("common.search")} emptyText={t("offers.copyNone")} />
        {copy.error && <p className="text-sm text-destructive">{copy.error.message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button disabled={!from || copy.isPending} onClick={() => copy.mutate()}>{t("offers.copyAction")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
