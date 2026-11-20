import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Copy, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { type CatalogEvent, etagOf, isConflict, type Offer, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { GroupAccessField } from "../../components/group-access.js";
import { formatMoney, moneyInput, parseMoney } from "../../lib/money.js";
import { offerName, useAccount, useEventOffers, useSalesChannels, useSkuMappings, useVatClasses } from "../../queries.js";
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
      void qc.invalidateQueries({ queryKey: ["sales-channels", accountId] });
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
  const channels = useSalesChannels();
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
      id: "channels",
      header: t("offers.channels"),
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.channelIds.map((id) => {
            const c = channels.data?.find((x) => x.id === id);
            const noSku = row.original.channelsWithoutSku.includes(id);
            return (
              <Badge key={id} variant={noSku ? "destructive" : "outline"} title={noSku ? t("offers.noSku") : undefined}>
                {noSku && <TriangleAlert />}{c?.name ?? "…"}
              </Badge>
            );
          })}
          {row.original.channelIds.length === 0 && <span className="text-xs text-muted-foreground">{t("offers.noChannels")}</span>}
        </div>
      ),
    },
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
  const skuGaps = (query.data ?? []).some((o) => o.status === "active" && o.channelsWithoutSku.length > 0);

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
      {skuGaps && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>{t("offers.skuGaps")}</AlertDescription>
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
  /** Null: untouched on a new offer, so the API gives it every active channel. */
  channelIds: string[] | null;
  accessGroupIds: string[];
  opens: WindowBound;
  closes: WindowBound;
  translations: Record<string, { name: string; description: string }>;
};

/** One end of the sales window: none (published / start), hours before the start, or a fixed time. */
type WindowBound = { mode: "none" | "before" | "at"; hours: string; at: string };

const hours = (min: number | null | undefined) => (min === null || min === undefined ? "" : String(min / 60));
/** datetime-local value in the browser's timezone. */
const localInput = (d: string | null | undefined) => {
  if (!d) return "";
  const x = new Date(d);
  return new Date(x.getTime() - x.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const bound = (min: number | null | undefined, at: string | null | undefined): WindowBound =>
  ({ mode: at ? "at" : min !== null && min !== undefined ? "before" : "none", hours: hours(min), at: localInput(at) });
const boundValid = (b: WindowBound) =>
  b.mode === "none" || (b.mode === "before" ? b.hours.trim() !== "" && Number(b.hours) >= 0 && Number(b.hours) <= 8760 : !Number.isNaN(Date.parse(b.at)));
/** The API fields for one bound; the other form is cleared. */
function boundFields(b: WindowBound, rel: "onSaleMinBefore" | "offSaleMinBefore", abs: "onSaleAt" | "offSaleAt") {
  if (b.mode === "before") return { [rel]: Math.round(Number(b.hours) * 60), [abs]: null };
  if (b.mode === "at") return { [rel]: null, [abs]: new Date(b.at).toISOString() };
  return { [rel]: null, [abs]: null };
}

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
  const allChannels = useSalesChannels().data ?? [];
  const skus = useSkuMappings().data ?? [];
  const locales = account?.locales ?? [];
  const [d, setD] = useState<Draft>(() => ({
    code: offer?.code ?? "",
    vatClassId: offer?.vatClassId ?? vat[0]?.id ?? "",
    price: moneyInput(offer?.defaultPrice, i18n.language),
    placesPerUnit: String(offer?.placesPerUnit ?? 1),
    min: String(offer?.minPerReservation ?? 1),
    max: String(offer?.maxPerReservation ?? 20),
    active: (offer?.status ?? "active") === "active",
    channelIds: offer?.channelIds ?? null,
    accessGroupIds: offer?.accessGroupIds ?? [],
    opens: bound(offer?.onSaleMinBefore, offer?.onSaleAt),
    closes: bound(offer?.offSaleMinBefore, offer?.offSaleAt),
    translations: Object.fromEntries((account?.locales ?? Object.keys(offer?.translations ?? {})).map((l) => [l, {
      name: offer?.translations[l]?.name ?? "", description: offer?.translations[l]?.description ?? "",
    }])),
  }));
  const price = parseMoney(d.price);
  const defaultLocale = account?.defaultLocale ?? "nb";
  const valid = price !== null && !!d.vatClassId && whole(d.placesPerUnit, 1, 100) && whole(d.min, 1, 1000) && whole(d.max, 1, 1000) &&
    Number(d.min) <= Number(d.max) && !!d.translations[defaultLocale]?.name.trim() && boundValid(d.opens) && boundValid(d.closes);
  // New offers start with every active channel, as the API defaults them.
  const channelIds = d.channelIds ?? allChannels.filter((c) => c.active).map((c) => c.id);
  const channels = allChannels.filter((c) => c.active || channelIds.includes(c.id));
  const hasSku = (channelId: string) => skus.some((m) => m.vatClassId === d.vatClassId && m.channelId === channelId);

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
        ...(d.channelIds ? { channelIds: d.channelIds } : {}),
        accessGroupIds: d.accessGroupIds,
        ...boundFields(d.opens, "onSaleMinBefore", "onSaleAt"),
        ...boundFields(d.closes, "offSaleMinBefore", "offSaleAt"),
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
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{t("offers.channels")}</legend>
          {channels.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <Checkbox id={`offer-channel-${c.id}`} checked={channelIds.includes(c.id)}
                onCheckedChange={(on) => setD({ ...d, channelIds: on ? [...channelIds, c.id] : channelIds.filter((x) => x !== c.id) })} />
              <Label htmlFor={`offer-channel-${c.id}`} className="font-normal">{c.name}</Label>
              {channelIds.includes(c.id) && !hasSku(c.id) && <Badge variant="destructive"><TriangleAlert /> {t("offers.noSkuShort")}</Badge>}
            </div>
          ))}
          {channels.length === 0 && <p className="text-xs text-muted-foreground">{t("offers.noChannelsYet")}</p>}
        </fieldset>
        <GroupAccessField id="offer-access" legend={t("groups.whoCanBuy")} everyone={t("groups.everyoneBuy")} hint={t("groups.whoCanBuyHint")}
          value={d.accessGroupIds} onChange={(accessGroupIds) => setD({ ...d, accessGroupIds })} />
        <div className="grid gap-4 sm:grid-cols-2">
          <WindowField id="offer-opens" label={t("offers.opens")} none={t("offers.opensNone")} value={d.opens} onChange={(opens) => setD({ ...d, opens })} />
          <WindowField id="offer-closes" label={t("offers.closes")} none={t("offers.closesNone")} value={d.closes} onChange={(closes) => setD({ ...d, closes })} />
          <p className="text-xs text-muted-foreground sm:col-span-2">{t("offers.windowHint")}</p>
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

function WindowField({ id, label, none, value, onChange }: { id: string; label: string; none: string; value: WindowBound; onChange(v: WindowBound): void }) {
  const { t } = useTranslation();
  return (
    <Field label={label} htmlFor={id}>
      <Select value={value.mode} onValueChange={(mode) => onChange({ ...value, mode: mode as WindowBound["mode"] })}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{none}</SelectItem>
          <SelectItem value="before">{t("offers.hoursBefore")}</SelectItem>
          <SelectItem value="at">{t("offers.atTime")}</SelectItem>
        </SelectContent>
      </Select>
      {value.mode === "before" && (
        <Input aria-label={`${label}: ${t("offers.hoursBefore")}`} type="number" min={0} max={8760} step="any" value={value.hours}
          onChange={(e) => onChange({ ...value, hours: e.target.value })} />
      )}
      {value.mode === "at" && (
        <Input aria-label={`${label}: ${t("offers.atTime")}`} type="datetime-local" value={value.at} onChange={(e) => onChange({ ...value, at: e.target.value })} />
      )}
    </Field>
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
