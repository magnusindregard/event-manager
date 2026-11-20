import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type ColumnDef, DataTable } from "@/components/data-table";
import { Field } from "@/components/page";
import { formatInZone } from "@/components/zoned-datetime";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type CatalogEvent, type PriceCell, type PriceGrid as Grid, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { formatMoney, moneyInput, parseMoney } from "../../lib/money.js";
import { offerName, useEventRules, useUserGroups } from "../../queries.js";
import { useOfferRefresh } from "./Offers.js";

type Row = Grid["items"][number];
type Offer = Grid["offers"][number];
type GroupCell = NonNullable<PriceCell["group"]>;

/**
 * The price grid (docs/ticketing.md, "Event → Prices"): offers × occurrences, each cell with its
 * effective price and availability and where they come from: the offer's default, a rule, or an
 * override on that occurrence, which can be set and cleared here.
 */
export function PriceGrid({ event }: { event: CatalogEvent }) {
  const { t, i18n } = useTranslation();
  const { api, accountId, can } = useApp();
  const rules = useEventRules(event.id).data ?? [];
  const groups = (useUserGroups().data ?? []).filter((g) => !g.archived);
  // "": everyone's price. A group shows what that group pays (docs/user-groups.md).
  const [groupId, setGroupId] = useState("");
  const query = useQuery({
    queryKey: ["prices", accountId, event.id, groupId],
    queryFn: async () => {
      // Every occurrence, a page at a time, like the schedule.
      const items: Row[] = [];
      let offers: Offer[] | undefined;
      let cursor: string | undefined;
      do {
        const page = unwrap(await api.GET("/v1/events/{id}/prices", { params: { path: { id: event.id }, query: { limit: 500, cursor, ...(groupId ? { groupId } : {}) } } }));
        offers ??= page.offers;
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && items.length < 10_000);
      return { offers: offers ?? [], items };
    },
  });
  const [upcoming, setUpcoming] = useState(true);
  const now = new Date().toISOString();
  const offers = (query.data?.offers ?? []).filter((o) => o.status === "active");
  const rows = (query.data?.items ?? []).filter((r) => !upcoming || r.endUtc > now);
  const canWrite = can("offers.write") && event.status !== "archived";
  const ruleName = (id: string | null) => rules.find((r) => r.id === id)?.name ?? "…";

  const columns: ColumnDef<Row>[] = [
    {
      id: "when",
      header: t("prices.occurrence"),
      cell: ({ row }) => (
        <div className="whitespace-nowrap">
          {formatInZone(row.original.startUtc, event.timezone, i18n.language)}
          {row.original.status === "cancelled" && <Badge variant="destructive" className="ml-2">{t("occurrences.cancelled")}</Badge>}
        </div>
      ),
    },
    ...offers.map((offer): ColumnDef<Row> => ({
      id: offer.id,
      header: () => {
        const own = groupId ? offer.groupPrices.find((g) => g.groupId === groupId) : undefined;
        return (
          <span>
            {offerName(offer, i18n.language)}
            <span className="block text-xs font-normal text-muted-foreground">
              {formatMoney(own?.amount ?? offer.defaultPrice, i18n.language)}{groupId && !own && ` · ${t("prices.groupNoOwn")}`}
            </span>
          </span>
        );
      },
      cell: ({ row }) => {
        const c = row.original.cells.find((x) => x.offerId === offer.id);
        if (!c) return <span className="text-xs text-muted-foreground">{t("prices.pending")}</span>;
        if (c.group) {
          const view = <GroupCellView cell={c.group} available={c.available.value} ruleName={ruleName} />;
          return canWrite ? <GroupCellEditor event={event} offer={offer} row={row.original} cell={c.group}>{view}</GroupCellEditor> : view;
        }
        const view = <CellView cell={c} ruleName={ruleName} />;
        return canWrite ? <CellEditor event={event} offer={offer} row={row.original} cell={c}>{view}</CellEditor> : view;
      },
    })),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-prose text-sm text-muted-foreground">{groupId ? t("prices.groupIntro") : t("prices.intro")}</p>
        <div className="flex flex-wrap gap-2">
        {groups.length > 0 && (
          <Select value={groupId || "all"} onValueChange={(v) => setGroupId(v === "all" ? "" : v)}>
            <SelectTrigger aria-label={t("prices.group")} className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("prices.everyone")}</SelectItem>
              {groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.names[i18n.language] ?? Object.values(g.names)[0] ?? g.code}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={upcoming ? "upcoming" : "all"} onValueChange={(v) => setUpcoming(v === "upcoming")}>
          <SelectTrigger aria-label={t("prices.show")} className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="upcoming">{t("prices.upcoming")}</SelectItem>
            <SelectItem value="all">{t("prices.all")}</SelectItem>
          </SelectContent>
        </Select>
        </div>
      </div>
      {query.data && offers.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{t("prices.noOffers")}</p>
      ) : (
        <div className="overflow-x-auto">
          <DataTable columns={columns} data={rows} loading={query.isLoading} empty={t("occurrences.empty")} getRowId={(r) => r.occurrenceId} />
        </div>
      )}
    </div>
  );
}

function CellView({ cell, ruleName }: { cell: PriceCell; ruleName(id: string | null): string }) {
  const { t, i18n } = useTranslation();
  const source = (s: { source: string; ruleId: string | null }) => (s.source === "rule" ? ruleName(s.ruleId) : t(`prices.source.${s.source}`));
  const off = !cell.available.value;
  return (
    <div className="grid gap-1 text-left">
      <span className={off ? "text-muted-foreground line-through" : "font-medium"}>{formatMoney(cell.price.value, i18n.language)}</span>
      {cell.price.source !== "default" && (
        <Badge variant={cell.price.source === "override" ? "default" : "secondary"} className="w-fit font-normal">{source(cell.price)}</Badge>
      )}
      {(off || cell.available.source !== "default") && (
        <Badge variant={off ? "destructive" : "outline"} className="w-fit font-normal">
          {off ? t("prices.offSale") : t("prices.onSale")}
          {cell.available.source !== "default" && ` · ${source(cell.available)}`}
        </Badge>
      )}
    </div>
  );
}

/** What one group pays here: its own setting with the source, or the general price greyed out. */
function GroupCellView({ cell, available, ruleName }: { cell: GroupCell; available: boolean; ruleName(id: string | null): string }) {
  const { t, i18n } = useTranslation();
  const source = cell.price.source === "rule" ? ruleName(cell.price.ruleId) : t(`prices.groupSource.${cell.price.source}`);
  return (
    <div className="grid gap-1 text-left">
      <span className={cell.inherited ? "text-muted-foreground" : available ? "font-medium" : "text-muted-foreground line-through"}>{formatMoney(cell.price.value, i18n.language)}</span>
      {cell.inherited
        ? <span className="text-xs text-muted-foreground">{t("prices.inherited")}</span>
        : <Badge variant={cell.price.source === "override" ? "default" : "secondary"} className="w-fit font-normal">{source}</Badge>}
      {!available && <Badge variant="destructive" className="w-fit font-normal">{t("prices.offSale")}</Badge>}
    </div>
  );
}

function GroupCellEditor({ event, offer, row, cell, children }: { event: CatalogEvent; offer: Offer; row: Row; cell: GroupCell; children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const { api } = useApp();
  const refresh = useOfferRefresh(event.id);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const parsed = parseMoney(amount);
  const save = useMutation({
    mutationFn: async (clear: boolean) => {
      const path = { id: offer.id, occurrenceId: row.occurrenceId, groupId: cell.groupId };
      const url = "/v1/offers/{id}/occurrences/{occurrenceId}/groups/{groupId}/override" as const;
      return clear ? unwrap(await api.DELETE(url, { params: { path } })) : unwrap(await api.PUT(url, { params: { path }, body: { amount: parsed! } }));
    },
    onSuccess: () => {
      setOpen(false);
      toast.success(t("common.saved"));
      refresh();
    },
  });
  const id = `gov-${offer.id}-${row.occurrenceId}`;
  return (
    <Popover open={open} onOpenChange={(o) => { if (o) setAmount(moneyInput(cell.override, i18n.language)); setOpen(o); }}>
      <PopoverTrigger asChild>
        <button type="button" className="-m-1 rounded p-1 hover:bg-muted focus-visible:outline-2"
          aria-label={t("prices.editCell", { offer: offerName(offer, i18n.language), when: formatInZone(row.startUtc, event.timezone, i18n.language) })}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (parsed !== null) save.mutate(false); }}>
          <p className="text-sm font-medium">{offerName(offer, i18n.language)} · {formatInZone(row.startUtc, event.timezone, i18n.language)}</p>
          <Field label={t("prices.groupOverride")} htmlFor={id} hint={t("prices.groupOverrideHint")}>
            <Input id={id} inputMode="decimal" value={amount} placeholder={moneyInput(cell.price.value, i18n.language)} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          {save.error && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{save.error.message}</AlertDescription>
            </Alert>
          )}
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={cell.override === null || save.isPending} onClick={() => save.mutate(true)}>{t("prices.clear")}</Button>
            <Button type="submit" size="sm" disabled={parsed === null || save.isPending}>{t("common.save")}</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

type Avail = "inherit" | "on" | "off";

function CellEditor({ event, offer, row, cell, children }: { event: CatalogEvent; offer: Offer; row: Row; cell: PriceCell; children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const { api } = useApp();
  const refresh = useOfferRefresh(event.id);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [avail, setAvail] = useState<Avail>("inherit");
  const reset = () => {
    setAmount(moneyInput(cell.override?.amount, i18n.language));
    setAvail(cell.override?.available === null || cell.override?.available === undefined ? "inherit" : cell.override.available ? "on" : "off");
  };
  const parsed = amount.trim() === "" ? null : parseMoney(amount);
  const invalid = amount.trim() !== "" && parsed === null;

  const save = useMutation({
    mutationFn: async (clear: boolean) => {
      const path = { id: offer.id, occurrenceId: row.occurrenceId };
      if (clear) return unwrap(await api.DELETE("/v1/offers/{id}/occurrences/{occurrenceId}/override", { params: { path } }));
      return unwrap(await api.PUT("/v1/offers/{id}/occurrences/{occurrenceId}/override", {
        params: { path }, body: { amount: parsed, available: avail === "inherit" ? null : avail === "on" },
      }));
    },
    onSuccess: () => {
      setOpen(false);
      toast.success(t("common.saved"));
      refresh();
    },
  });

  return (
    <Popover open={open} onOpenChange={(o) => { if (o) reset(); setOpen(o); }}>
      <PopoverTrigger asChild>
        <button type="button" className="-m-1 rounded p-1 hover:bg-muted focus-visible:outline-2"
          aria-label={t("prices.editCell", { offer: offerName(offer, i18n.language), when: formatInZone(row.startUtc, event.timezone, i18n.language) })}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (!invalid) save.mutate(false); }}>
          <p className="text-sm font-medium">{offerName(offer, i18n.language)} · {formatInZone(row.startUtc, event.timezone, i18n.language)}</p>
          <Field label={t("prices.overridePrice")} htmlFor={`ov-${offer.id}-${row.occurrenceId}`} hint={t("prices.overrideHint")}>
            <Input id={`ov-${offer.id}-${row.occurrenceId}`} inputMode="decimal" value={amount} aria-invalid={invalid}
              placeholder={cell.price.source === "override" ? "" : moneyInput(cell.price.value, i18n.language)} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label={t("prices.availability")} htmlFor={`av-${offer.id}-${row.occurrenceId}`}>
            <Select value={avail} onValueChange={(v) => setAvail(v as Avail)}>
              <SelectTrigger id={`av-${offer.id}-${row.occurrenceId}`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">{t("prices.inherit")}</SelectItem>
                <SelectItem value="on">{t("prices.onSale")}</SelectItem>
                <SelectItem value="off">{t("prices.offSale")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {save.error && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{save.error.message}</AlertDescription>
            </Alert>
          )}
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={!cell.override || save.isPending} onClick={() => save.mutate(true)}>{t("prices.clear")}</Button>
            <Button type="submit" size="sm" disabled={invalid || save.isPending}>{t("common.save")}</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
