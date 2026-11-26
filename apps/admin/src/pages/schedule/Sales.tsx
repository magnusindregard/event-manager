import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type ColumnDef, DataTable } from "@/components/data-table";
import { Field } from "@/components/page";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiProblem, type CatalogEvent, type Occurrence, type OccurrenceSales, type SalesReservation, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { useUserGroups } from "../../queries.js";
import { formatMoney } from "../../lib/money.js";

const ATTENDEE_URL = (import.meta.env.VITE_ATTENDEE_URL ?? "").replace(/\/+$/, "");

type Show = "confirmed" | "held" | "ended";
type Selection = { reservation: SalesReservation; ticketIds: string[] };
const statusVariant: Record<SalesReservation["status"], "default" | "secondary" | "outline" | "destructive"> = {
  confirmed: "default", held: "secondary", cancelled: "outline", expired: "outline",
};

/**
 * Occurrence → Sales (docs/ticketing.md, "Admin interface"): held and sold per offer, the
 * reservations with their channel's order references and buyers, and cancelling tickets
 * (sales.write). For a shop's sale, cancelling here does not refund: the money moves in the
 * channel. For a sale in the hosted checkout (docs/checkout.md), cancelling refunds the
 * tickets through Vipps, after staff confirm the amount.
 */
export function Sales({ event, occurrence, label, onClose }: { event: CatalogEvent; occurrence: Occurrence | null; label: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { api, accountId, can } = useApp();
  const qc = useQueryClient();
  const [show, setShow] = useState<Show>("confirmed");
  // Ticked tickets of one reservation, and what the confirm dialog is about to cancel.
  const [selection, setSelection] = useState<Selection | null>(null);
  const [confirming, setConfirming] = useState<Selection | null>(null);
  const [refundRef, setRefundRef] = useState("");
  const key = ["sales", accountId, occurrence?.id];
  const canWrite = can("sales.write");
  const money = (minor: number) => formatMoney(minor, i18n.language);

  const query = useQuery({
    queryKey: key,
    enabled: !!occurrence,
    queryFn: async (): Promise<OccurrenceSales> => unwrap(await api.GET("/v1/occurrences/{id}/sales", { params: { path: { id: occurrence!.id } } })),
  });
  // The hosted checkout's ticket link (docs/checkout.md), when the account sells through it.
  const paymentsSettings = useQuery({ queryKey: ["payments", accountId], enabled: !!occurrence, queryFn: async () => unwrap(await api.GET("/v1/payments")) });
  const ticketLink = ATTENDEE_URL && occurrence && event.status === "published" && paymentsSettings.data?.checkout?.active && paymentsSettings.data.vipps?.status === "active"
    ? `${ATTENDEE_URL}/b/${occurrence.id}` : null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["occurrences", accountId, event.id] });
    void qc.invalidateQueries({ queryKey: ["audit", accountId] });
  };
  /** What the chosen tickets cost: the amount a hosted sale refunds. */
  const amountOf = (c: Selection) => c.ticketIds.reduce((s, id) => {
    const tk = c.reservation.tickets.find((x) => x.id === id);
    return s + (c.reservation.lines.find((l) => l.id === tk?.lineId)?.unitPrice ?? 0);
  }, 0);
  const paidHere = (c: Selection | null) => c?.reservation.payment?.state === "captured";
  const cancel = useMutation({
    mutationFn: async (c: Selection) => {
      if (paidHere(c)) {
        const r = await api.POST("/v1/sales/reservations/{id}/refund", { params: { path: { id: c.reservation.id } }, body: { ticketIds: c.ticketIds, amount: amountOf(c) } });
        if (r.error) unwrap(r);
        return r.data ?? null;
      }
      unwrap(await api.POST("/v1/sales/reservations/{id}/cancel", {
        params: { path: { id: c.reservation.id } },
        body: { ticketIds: c.ticketIds, ...(refundRef.trim() ? { externalRefundRef: refundRef.trim() } : {}) },
      }));
      return null;
    },
    onSuccess: (refund, c) => {
      if (refund && refund.state !== "done") toast.warning(t(`sales.refund.${refund.state}`));
      else toast.success(paidHere(c) ? t("sales.refund.done", { amount: money(amountOf(c)) }) : t("sales.cancelledToast", { count: c.ticketIds.length }));
      setSelection(null);
      setConfirming(null);
      setRefundRef("");
      refresh();
    },
    onError: (e) => {
      refresh();
      toast.error(e instanceof ApiProblem && ["occurrence_started", "already_cancelled"].includes(e.code) ? t(`sales.errors.${e.code}`) : e instanceof ApiProblem ? e.message : t("error.generic"));
    },
  });
  const retry = useMutation({
    mutationFn: async (refundId: string) => unwrap(await api.POST("/v1/sales/refunds/{id}/retry", { params: { path: { id: refundId } } })),
    onSuccess: (r) => {
      if (r.state === "done") toast.success(t("sales.refund.done", { amount: money(r.amount) }));
      else toast.warning(t(`sales.refund.${r.state}`));
      refresh();
    },
    onError: () => toast.error(t("error.generic")),
  });

  const data = query.data;
  const all = data?.reservations ?? [];
  const rows = all.filter((r) => (show === "ended" ? r.status === "cancelled" || r.status === "expired" : r.status === show));
  const count = (s: Show) => all.filter((r) => (s === "ended" ? r.status === "cancelled" || r.status === "expired" : r.status === s)).length;
  const offerName = new Map((data?.offers ?? []).map((o) => [o.offerId, o.name]));
  const userGroups = useUserGroups().data ?? [];
  const groupName = (code: string) => {
    const g = userGroups.find((x) => x.code === code);
    return g ? (g.names[i18n.language] ?? Object.values(g.names)[0] ?? code) : code;
  };
  const when = (iso: string) => new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: event.timezone }).format(new Date(iso));
  const sold = (data?.offers ?? []).reduce((s, o) => ({ units: s.units + o.sold, revenue: s.revenue + o.revenue }), { units: 0, revenue: 0 });

  const columns: ColumnDef<SalesReservation>[] = [
    {
      id: "order",
      header: t("sales.order"),
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="grid gap-0.5">
            <span className="font-medium">{r.externalOrderRef ?? r.externalRef ?? <span className="text-muted-foreground italic">{t("sales.noRef")}</span>}</span>
            <span className="text-muted-foreground text-xs">{r.channel.name} · {when(r.confirmedAt ?? r.createdAt)}</span>
            {r.anonymisedAt ? (
              <span className="text-muted-foreground text-xs italic">{t("sales.anonymised")}</span>
            ) : r.buyer && (
              <span className="text-xs">{[r.buyer.name, r.buyer.email].filter(Boolean).join(" · ")}</span>
            )}
            {r.otherOccurrences && <span className="text-muted-foreground text-xs">{t("sales.otherOccurrences")}</span>}
            {r.payment && (
              <span className="text-muted-foreground text-xs">
                {t("sales.payment.vipps", { state: t(`sales.payment.states.${r.payment.state}`) })}
                {r.payment.refunded > 0 && ` · ${t("sales.payment.refunded", { amount: money(r.payment.refunded) })}`}
              </span>
            )}
            {r.payment?.refunds.filter((x) => x.state !== "done").map((x) => (
              <span key={x.id} className="flex items-center gap-2 text-xs text-destructive">
                {t(`sales.refund.${x.state}`)} ({money(x.amount)}){x.failureReason ? `: ${x.failureReason}` : ""}
                {canWrite && <Button variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={retry.isPending} onClick={() => retry.mutate(x.id)}>{t("sales.refund.retry")}</Button>}
              </span>
            ))}
          </div>
        );
      },
    },
    {
      id: "lines",
      header: t("sales.tickets"),
      cell: ({ row }) => {
        const r = row.original;
        if (r.status !== "confirmed" && r.tickets.length === 0) {
          return <div className="grid gap-0.5 text-sm">{r.lines.map((l) => <span key={l.id}>{l.quantity} × {offerName.get(l.offerId) ?? l.offerCode}</span>)}</div>;
        }
        return (
          <ul className="grid gap-1 text-sm">
            {r.tickets.map((tk) => (
              <li key={tk.id} className="flex items-center gap-2">
                {canWrite && r.status === "confirmed" && (
                  <Checkbox aria-label={t("sales.selectTicket", { offer: offerName.get(tk.offerId) ?? "" })} disabled={tk.status !== "valid"}
                    checked={selection?.reservation.id === r.id && selection.ticketIds.includes(tk.id)}
                    onCheckedChange={(v) => {
                      const current = selection?.reservation.id === r.id ? selection.ticketIds : [];
                      const next = v === true ? [...current, tk.id] : current.filter((x) => x !== tk.id);
                      setSelection(next.length ? { reservation: r, ticketIds: next } : null);
                    }} />
                )}
                <span className={tk.status === "cancelled" ? "text-muted-foreground line-through" : ""}>
                  {offerName.get(tk.offerId) ?? ""}{tk.partySize > 1 ? ` (${tk.partySize})` : ""}
                </span>
                {tk.status === "cancelled" && (
                  <span className="text-muted-foreground text-xs">
                    {t(`sales.cancelledBy.${tk.cancelledBy ?? "channel"}`)}
                    {/* A hosted sale's refund reference is ours; say what it means instead. */}
                    {tk.externalRefundRef ? ` · ${(() => {
                      const refund = r.payment?.refunds.find((x) => x.reference === tk.externalRefundRef);
                      return refund ? t(`sales.refund.ticket.${refund.state}`) : tk.externalRefundRef;
                    })()}` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        );
      },
    },
    { id: "total", header: t("sales.total"), cell: ({ row }) => <span className="tabular-nums whitespace-nowrap">{money(row.original.total.amount)}</span> },
    {
      id: "status",
      header: () => <span className="sr-only">{t("events.status")}</span>,
      cell: ({ row }) => {
        const r = row.original;
        const valid = r.tickets.filter((x) => x.status === "valid").map((x) => x.id);
        return (
          <div className="flex items-center justify-end gap-1">
            <Badge variant={statusVariant[r.status]}>{t(`sales.status.${r.status}`)}</Badge>
            {canWrite && r.status === "confirmed" && valid.length > 0 && (
              <Button variant="ghost" size="icon" aria-label={t("sales.cancelAllFor", { order: r.externalOrderRef ?? "" })} onClick={() => setConfirming({ reservation: r, ticketIds: valid })}>
                <X />
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  const pool = data?.pool;
  return (
    <>
      <Sheet open={!!occurrence} onOpenChange={(o) => !o && onClose()}>
        <SheetContent className="sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("sales.title")}</SheetTitle>
            <SheetDescription>{label}</SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4 pb-6">
            <p className="text-sm" aria-live="polite">
              {t("sales.summary", { count: sold.units, revenue: money(sold.revenue) })}
              {pool && pool.bookableLimit !== null && <> · {t("occurrences.placesOf", { taken: pool.taken + pool.held, limit: pool.bookableLimit })}</>}
              {pool && pool.held > 0 && <> · {t("sales.heldPlaces", { count: pool.held })}</>}
            </p>
            {ticketLink && (
              <div className="grid gap-1 rounded-lg border p-3">
                <span className="text-sm font-medium">{t("sales.ticketLink")}</span>
                <div className="flex items-center gap-2">
                  <Input readOnly value={ticketLink} aria-label={t("sales.ticketLink")} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                  <Button variant="outline" size="icon" aria-label={t("sales.copyLink")}
                    onClick={(e) => {
                      const input = e.currentTarget.parentElement?.querySelector("input");
                      void navigator.clipboard.writeText(ticketLink).then(
                        () => toast.success(t("sales.linkCopied")),
                        // No clipboard access: select the link so it can be copied by hand.
                        () => { input?.select(); toast.info(t("sales.linkSelect")); },
                      );
                    }}>
                    <Copy />
                  </Button>
                  <Button variant="outline" size="icon" asChild aria-label={t("sales.openLink")}>
                    <a href={ticketLink} target="_blank" rel="noreferrer"><ExternalLink /></a>
                  </Button>
                </div>
                <span className="text-muted-foreground text-xs">{t("sales.ticketLinkHint")}</span>
              </div>
            )}

            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-3 py-2 text-left font-medium">{t("sales.offer")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("sales.held")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("sales.sold")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("sales.cancelled")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("sales.revenue")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.offers ?? []).map((o) => (
                    <tr key={o.offerId} className="border-b last:border-0">
                      <td className="px-3 py-2">
                        {o.name}
                        {/* Per user group, when any group bought (docs/user-groups.md). */}
                        {o.byGroup.some((g) => g.group !== null) && (
                          <span className="block text-xs text-muted-foreground">
                            {o.byGroup.map((g) => `${g.group === null ? t("sales.noGroup") : groupName(g.group)}: ${g.sold} · ${money(g.revenue)}`).join(", ")}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{o.held}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{o.sold}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{o.cancelled}</td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(o.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Tabs value={show} onValueChange={(v) => setShow(v as Show)}>
              <TabsList>
                <TabsTrigger value="confirmed">{t("sales.tabs.confirmed")} ({count("confirmed")})</TabsTrigger>
                <TabsTrigger value="held">{t("sales.tabs.held")} ({count("held")})</TabsTrigger>
                <TabsTrigger value="ended">{t("sales.tabs.ended")} ({count("ended")})</TabsTrigger>
              </TabsList>
            </Tabs>
            <DataTable columns={columns} data={rows} loading={query.isLoading} empty={t("sales.empty")} getRowId={(r) => r.id} />
            {canWrite && selection && show === "confirmed" && (
              <div className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <span>{t("sales.selected", { count: selection.ticketIds.length, order: selection.reservation.externalOrderRef ?? "" })}</span>
                <Button size="sm" variant="destructive" onClick={() => setConfirming(selection)}>{t("sales.cancelSelected")}</Button>
              </div>
            )}
            <p className="text-muted-foreground text-xs">{t("sales.help")}</p>
          </div>
        </SheetContent>
      </Sheet>
      <CancelDialog
        open={!!confirming}
        count={confirming?.ticketIds.length ?? 0}
        order={confirming?.reservation.externalOrderRef ?? ""}
        refundRef={refundRef}
        onRefundRef={setRefundRef}
        refund={paidHere(confirming) && confirming ? money(amountOf(confirming)) : null}
        pending={cancel.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => confirming && cancel.mutate(confirming)}
      />
    </>
  );
}

function CancelDialog(p: {
  open: boolean; count: number; order: string; refundRef: string; pending: boolean;
  /** Paid in the hosted checkout: the amount that will be refunded through Vipps. */
  refund: string | null;
  onRefundRef: (v: string) => void; onCancel: () => void; onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={p.open} onOpenChange={(o) => !o && p.onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("sales.cancelTitle", { count: p.count, order: p.order })}</AlertDialogTitle>
          <AlertDialogDescription>{p.refund ? t("sales.refund.body", { amount: p.refund }) : t("sales.cancelBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        {!p.refund && (
          <Field label={t("sales.refundRef")} htmlFor="refund-ref" hint={t("sales.refundRefHint")}>
            <Input id="refund-ref" maxLength={200} autoComplete="off" value={p.refundRef} onChange={(e) => p.onRefundRef(e.target.value)} />
          </Field>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.back")}</AlertDialogCancel>
          <AlertDialogAction onClick={p.onConfirm} disabled={p.pending}>{p.refund ? t("sales.refund.confirm", { amount: p.refund }) : t("sales.cancelConfirm", { count: p.count })}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
