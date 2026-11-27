import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, CircleAlert, Copy, Download, FileUp, MoreHorizontal, RefreshCw, Send, Trash2, UserPlus } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type ColumnDef, DataTable } from "@/components/data-table";
import { Field } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiProblem, type CatalogEvent, type GuestInvitation, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { sendFailure } from "../../lib/send-failure.js";
import { EventSending } from "./EventSending.js";
import { GuestImport } from "./GuestImport.js";

// Event → Guest list (docs/registration.md, "Admin interface"): import, list with status
// filters and counts, send / resend / remind, personal links and their export.

type Status = GuestInvitation["status"];
const STATUSES: Status[] = ["pending", "sent", "accepted", "declined"];
type Filter = Status | "all" | "undeliverable";
const undeliverable = (g: GuestInvitation) => g.lastSend?.deliveryStatus === "bounced" || g.lastSend?.deliveryStatus === "spam_complaint";
const statusVariant: Record<Status, "default" | "secondary" | "outline" | "destructive"> = { pending: "outline", sent: "secondary", accepted: "default", declined: "outline" };

type Confirm = { kind: "invitation" | "reminder"; ids?: string[]; count: number } | { kind: "remove"; ids: string[]; count: number } | null;

export function GuestList({ event }: { event: CatalogEvent }) {
  const { t, i18n } = useTranslation();
  const { api, accountId, can } = useApp();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState<false | "new" | "refresh">(false);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const key = ["invitations", accountId, event.id];
  const published = event.status === "published";
  const canWrite = can("registrations.write");

  // HubSpot connected: the import offers a HubSpot list, and the remembered list can be fetched again.
  const integrations = useQuery({ queryKey: ["integrations", accountId], queryFn: async () => unwrap(await api.GET("/v1/integrations")) });
  const hubspot = integrations.data?.items.some((c) => c.provider === "hubspot" && c.status === "active") ?? false;
  const guestSource = useQuery({
    queryKey: ["guest-source", event.id],
    enabled: hubspot,
    queryFn: async () => unwrap(await api.GET("/v1/events/{id}/guest-source", { params: { path: { id: event.id } } })).source,
  });
  const query = useQuery({
    queryKey: key,
    queryFn: async () => unwrap(await api.GET("/v1/events/{id}/invitations", { params: { path: { id: event.id } } })),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["audit", accountId] });
  };
  const problemText = (e: unknown) => (e instanceof ApiProblem && (e.code === "conflict" || e.code === "validation_failed") ? e.message : t("error.generic"));

  const items = query.data?.items ?? [];
  const counts = query.data?.counts;
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((g) =>
      (filter === "all" || (filter === "undeliverable" ? undeliverable(g) : g.status === filter)) &&
      (!q || g.email.includes(q) || (g.name ?? "").toLowerCase().includes(q)));
  }, [items, filter, search]);
  const selectedRows = items.filter((g) => selected.has(g.id));

  const send = useMutation({
    mutationFn: async (c: { kind: "invitation" | "reminder"; ids?: string[] }) =>
      unwrap(await api.POST("/v1/events/{id}/invitations/send", { params: { path: { id: event.id } }, body: c.ids ? { kind: c.kind, ids: c.ids } : { kind: c.kind } })),
    onSuccess: (r, c) => {
      toast.success(t(c.kind === "invitation" ? "guests.sentToast" : "guests.remindedToast", { count: r.queued }) + (r.skipped ? ` ${t("guests.skipped", { count: r.skipped })}` : ""));
      setSelected(new Set());
      setConfirm(null);
      refresh();
      // Sends are logged as they go out; look again shortly.
      setTimeout(refresh, 4000);
    },
    onError: (e) => toast.error(problemText(e)),
  });
  const remove = useMutation({
    mutationFn: async (ids: string[]) => unwrap(await api.POST("/v1/events/{id}/invitations/remove", { params: { path: { id: event.id } }, body: { ids } })),
    onSuccess: (r) => {
      toast.success(t("guests.removedToast", { count: r.removed.length }) + (r.blocked.length ? ` ${t("guests.blockedToast", { count: r.blocked.length })}` : ""));
      setSelected(new Set());
      setConfirm(null);
      refresh();
    },
    onError: (e) => toast.error(problemText(e)),
  });
  const markSent = useMutation({
    mutationFn: async (ids: string[]) => unwrap(await api.POST("/v1/events/{id}/invitations/mark-sent", { params: { path: { id: event.id } }, body: { ids } })),
    onSuccess: (r) => {
      toast.success(t("guests.markedToast", { count: r.marked }));
      setSelected(new Set());
      refresh();
    },
    onError: (e) => toast.error(problemText(e)),
  });
  const copyLink = async (g: GuestInvitation, rotate = false) => {
    try {
      const r = rotate
        ? unwrap(await api.POST("/v1/invitations/{id}/rotate-link", { params: { path: { id: g.id } } }))
        : unwrap(await api.GET("/v1/invitations/{id}/link", { params: { path: { id: g.id } } }));
      await navigator.clipboard.writeText(r.url);
      toast.success(rotate ? t("guests.rotatedToast") : t("guests.copiedToast"));
      if (rotate) refresh();
    } catch (e) {
      toast.error(problemText(e));
    }
  };
  const exportLinks = async () => {
    try {
      const r = await api.GET("/v1/events/{id}/invitations/links.csv", { params: { path: { id: event.id } }, parseAs: "blob" });
      if (r.error || !r.data) throw new ApiProblem(r.response.status, "unknown", r.response.statusText);
      const url = URL.createObjectURL(r.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${event.slug}-guest-links.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(problemText(e));
    }
  };

  const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat(i18n.language === "nb" ? "nb-NO" : "en-GB", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) : "");
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  const allShown = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const columns: ColumnDef<GuestInvitation>[] = [
    ...(canWrite ? [{
      id: "select",
      header: () => (
        <Checkbox aria-label={t("guests.selectAll")} checked={allShown ? true : rows.some((r) => selected.has(r.id)) ? "indeterminate" : false}
          onCheckedChange={(v) => setSelected(v === true ? new Set([...selected, ...rows.map((r) => r.id)]) : new Set([...selected].filter((id) => !rows.some((r) => r.id === id))))} />
      ),
      cell: ({ row }: { row: { original: GuestInvitation } }) => (
        <Checkbox aria-label={t("guests.select", { email: row.original.email })} checked={selected.has(row.original.id)} onCheckedChange={(v) => toggle(row.original.id, v === true)} />
      ),
    } satisfies ColumnDef<GuestInvitation>] : []),
    {
      id: "guest",
      header: t("guests.guest"),
      cell: ({ row }) => (
        <div className="grid">
          <span className="font-medium">{row.original.name ?? <span className="text-muted-foreground">{t("guests.noName")}</span>}</span>
          <span className="text-muted-foreground text-xs">{row.original.email}</span>
        </div>
      ),
    },
    {
      id: "status",
      header: t("guests.status"),
      cell: ({ row }) => {
        const g = row.original;
        return (
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant={statusVariant[g.status]}>{t(`guests.statuses.${g.status}`)}</Badge>
            {g.registration && <span className="text-muted-foreground text-xs">{t("guests.party", { count: g.registration.partySize })}</span>}
            {undeliverable(g) && <Badge variant="destructive" title={g.lastSend?.deliveryDetail ?? undefined}>{t(`guests.delivery.${g.lastSend!.deliveryStatus}`)}</Badge>}
            {g.lastSend?.deliveryStatus === "failed" && <Badge variant="destructive" title={g.lastSend.deliveryDetail ?? undefined}>{t("guests.delivery.failed")}</Badge>}
          </div>
        );
      },
    },
    {
      id: "sent",
      header: t("guests.lastSent"),
      cell: ({ row }) => {
        const s = row.original.lastSend;
        if (!s) return <span className="text-muted-foreground text-xs">{t("guests.notSent")}</span>;
        if (!s.sentAt && s.unresolved) {
          return <span className="max-w-64 text-xs text-destructive" title={s.deliveryDetail ?? undefined}>{t("guests.unresolved")}</span>;
        }
        if (!s.sentAt && s.deliveryStatus === "queued") return <span className="text-muted-foreground text-xs" title={s.deliveryDetail ?? undefined}>{t("guests.queued")}</span>;
        // Never sent: show when it failed and why, not the time it was asked for as if it went out.
        if (!s.sentAt && s.deliveryStatus === "failed") {
          return (
            <div className="grid max-w-64 text-xs" title={s.deliveryDetail ?? undefined}>
              <span className="text-destructive">{t("guests.failedAt", { when: fmt(s.deliveryAt ?? s.requestedAt) })}</span>
              <span className="text-muted-foreground">{t(`guests.kinds.${s.kind}`)} · {t(`guests.failure.${sendFailure(s.deliveryDetail)}`)}</span>
              {/* HubSpot refused it first: the platform's email was the fallback that failed. */}
              {s.fallbackReason && <span className="text-muted-foreground" title={s.fallbackReason}>{s.fallbackReason}</span>}
            </div>
          );
        }
        return (
          <div className="grid text-xs">
            <span>{fmt(s.sentAt ?? s.requestedAt)}</span>
            <span className="text-muted-foreground">
              {t(`guests.kinds.${s.kind}`)}
              {s.deliveryDetail === "external" ? ` · ${t("guests.external")}` : s.deliveryStatus === "delivered" ? ` · ${t("guests.delivery.delivered")}` : ""}
              {s.channel === "hubspot" ? ` · ${t("guests.viaHubSpot")}` : ""}
            </span>
            {s.fallbackReason && <span className="max-w-64 text-muted-foreground" title={s.fallbackReason}>{t("guests.byPlatform", { reason: s.fallbackReason })}</span>}
          </div>
        );
      },
    },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("common.actions")}</span>,
      cell: ({ row }) => {
        const g = row.original;
        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t("guests.actionsFor", { email: g.email })}><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void copyLink(g)}><Copy /> {t("guests.copyLink")}</DropdownMenuItem>
                {canWrite && (
                  <>
                    {g.status !== "accepted" && published && (
                      <DropdownMenuItem onSelect={() => send.mutate({ kind: "invitation", ids: [g.id] })}><Send /> {g.status === "pending" ? t("guests.sendOne") : t("guests.resendOne")}</DropdownMenuItem>
                    )}
                    {g.status === "sent" && published && <DropdownMenuItem onSelect={() => send.mutate({ kind: "reminder", ids: [g.id] })}><BellRing /> {t("guests.remindOne")}</DropdownMenuItem>}
                    <DropdownMenuItem onSelect={() => void copyLink(g, true)}><RefreshCw /> {t("guests.rotateLink")}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" disabled={g.status === "accepted"} onSelect={() => setConfirm({ kind: "remove", ids: [g.id], count: 1 })}>
                      <Trash2 /> {g.status === "accepted" ? t("guests.removeBlocked") : t("guests.removeOne")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  const pendingCount = counts?.pending ?? 0;
  const noAnswer = counts?.sent ?? 0;

  return (
    <div className="grid gap-4">
      {!published && (
        <Alert>
          <CircleAlert />
          <AlertDescription>{t("guests.publishFirst")}</AlertDescription>
        </Alert>
      )}
      {event.registration.accessPolicy === "open" && (
        <p className="text-muted-foreground text-sm">{t("guests.openHint")}</p>
      )}
      <EventSending event={event} />

      {counts && (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5" aria-label={t("guests.countsLabel")}>
          {([["total", counts.total], ["accepted", counts.accepted], ["declined", counts.declined], ["noAnswer", counts.sent], ["notSent", counts.pending]] as const).map(([k, v]) => (
            <div key={k} className="rounded-lg border p-3">
              <dt className="text-muted-foreground text-xs">{t(`guests.counts.${k}`)}</dt>
              <dd className="text-xl font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {counts && counts.accepted > 0 && <p className="text-sm text-muted-foreground">{t("guests.places", { count: counts.places })}{counts.undeliverable ? ` · ${t("guests.undeliverableCount", { count: counts.undeliverable })}` : ""}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {canWrite && (
          <>
            <Button onClick={() => setImporting("new")}><FileUp /> {t("guests.import.open")}</Button>
            {hubspot && guestSource.data && (
              <Button variant="outline" onClick={() => setImporting("refresh")} title={t("guests.import.refreshHint", { name: guestSource.data.listName })}>
                <RefreshCw /> {t("guests.import.refresh")}
              </Button>
            )}
            <Button variant="outline" onClick={() => setAdding(true)}><UserPlus /> {t("guests.add")}</Button>
            <Button variant="outline" disabled={!published || pendingCount === 0} onClick={() => setConfirm({ kind: "invitation", count: pendingCount })}>
              <Send /> {t("guests.sendAll", { count: pendingCount })}
            </Button>
            <Button variant="outline" disabled={!published || noAnswer === 0} onClick={() => setConfirm({ kind: "reminder", count: noAnswer })}>
              <BellRing /> {t("guests.remindAll", { count: noAnswer })}
            </Button>
          </>
        )}
        <Button variant="ghost" onClick={() => void exportLinks()} disabled={!items.length}><Download /> {t("guests.exportLinks")}</Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-full sm:w-64" type="search" placeholder={t("guests.search")} aria-label={t("guests.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <SelectTrigger className="w-full sm:w-48" aria-label={t("guests.status")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("guests.allStatuses")}</SelectItem>
            {STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`guests.statuses.${s}`)}</SelectItem>)}
            <SelectItem value="undeliverable">{t("guests.undeliverable")}</SelectItem>
          </SelectContent>
        </Select>
        {canWrite && items.length > 0 && (
          // Always rendered, at a fixed height, so selecting never moves the table under the pointer.
          <div className="flex min-h-9 flex-wrap items-center gap-2 text-sm lg:ml-auto" role="region" aria-label={t("guests.selection")} aria-live="polite">
            {selected.size === 0 ? <span className="text-muted-foreground px-1">{t("guests.selectHint")}</span> : <>
            <span className="px-1">{t("guests.selected", { count: selected.size })}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline"><MoreHorizontal /> {t("common.actions")}</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!published} onSelect={() => setConfirm({ kind: "invitation", ids: [...selected], count: selectedRows.filter((g) => g.status === "pending" || g.status === "sent").length })}>
                  <Send /> {t("guests.sendSelected")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!published} onSelect={() => setConfirm({ kind: "reminder", ids: [...selected], count: selectedRows.filter((g) => g.status === "sent").length })}>
                  <BellRing /> {t("guests.remindSelected")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!selectedRows.some((g) => g.status === "pending")} onSelect={() => markSent.mutate([...selected])}>{t("guests.markSent")}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirm({ kind: "remove", ids: [...selected], count: selected.size })}><Trash2 /> {t("guests.removeSelected")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{t("guests.clearSelection")}</Button>
            </>}
          </div>
        )}
      </div>

      <DataTable columns={columns} data={rows} loading={query.isLoading} empty={items.length ? t("common.noResults") : t("guests.empty")} getRowId={(r) => r.id} />

      <GuestImport eventId={event.id} open={!!importing} hubspot={hubspot} refresh={importing === "refresh"} onClose={() => setImporting(false)}
        onDone={() => { refresh(); void guestSource.refetch(); }} />
      <AddGuest event={event} open={adding} onClose={() => setAdding(false)} onDone={refresh} />

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "remove" ? t("guests.confirmRemove", { count: confirm.count }) : confirm?.kind === "reminder" ? t("guests.confirmRemind", { count: confirm.count }) : t("guests.confirmSend", { count: confirm?.count ?? 0 })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "remove" ? t("guests.confirmRemoveBody") : confirm?.kind === "reminder" ? t("guests.confirmRemindBody") : t("guests.confirmSendBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.back")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={send.isPending || remove.isPending || !confirm?.count}
              onClick={(e) => {
                e.preventDefault();
                if (!confirm) return;
                if (confirm.kind === "remove") remove.mutate(confirm.ids);
                else send.mutate({ kind: confirm.kind, ids: confirm.ids });
              }}
            >
              {confirm?.kind === "remove" ? t("guests.removeConfirm") : t("guests.sendConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AddGuest({ event, open, onClose, onDone }: { event: CatalogEvent; open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const { api } = useApp();
  const [form, setForm] = useState({ email: "", name: "", guest: "default" as "default" | "yes" | "no" });
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/v1/events/{id}/invitations", {
        params: { path: { id: event.id } },
        body: { email: form.email, name: form.name.trim() || null, guestAllowed: form.guest === "default" ? null : form.guest === "yes" },
      })),
    onSuccess: (g) => {
      toast.success(t("guests.addedToast", { email: g.email }));
      setForm({ email: "", name: "", guest: "default" });
      setError(null);
      onDone();
      onClose();
    },
    onError: (e) => setError(e instanceof ApiProblem && (e.code === "conflict" || e.code === "validation_failed") ? e.message : t("error.generic")),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("guests.add")}</DialogTitle>
            <DialogDescription>{t("guests.addHelp")}</DialogDescription>
          </DialogHeader>
          <Field label={t("registrations.email")} htmlFor="guest-email">
            <Input id="guest-email" type="email" required maxLength={254} autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label={t("registrations.name")} htmlFor="guest-name" hint={t("guests.nameHint")}>
            <Input id="guest-name" maxLength={200} autoComplete="off" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={t("guests.guestAllowed")} htmlFor="guest-allowed">
            <Select value={form.guest} onValueChange={(v) => setForm({ ...form, guest: v as typeof form.guest })}>
              <SelectTrigger id="guest-allowed" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t(event.registration.guestAllowed ? "guests.guestDefaultYes" : "guests.guestDefaultNo")}</SelectItem>
                <SelectItem value="yes">{t("guests.guestYes")}</SelectItem>
                <SelectItem value="no">{t("guests.guestNo")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={add.isPending || !form.email.trim()}>{t("guests.addButton")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
