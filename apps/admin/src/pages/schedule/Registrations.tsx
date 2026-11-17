import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, UserPlus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiProblem, type CatalogEvent, type Occurrence, type Registration, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";

const ATTENDEE_URL = (import.meta.env.VITE_ATTENDEE_URL ?? "").replace(/\/+$/, "");

/**
 * An occurrence's registrations (docs/registration.md, "Occurrence → Registrations"): who is
 * coming, with party size and source; add someone by hand or cancel. Waitlist, moving and the
 * door list come in later milestones.
 */
export function Registrations({ event, occurrence, label, onClose }: { event: CatalogEvent; occurrence: Occurrence | null; label: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const [show, setShow] = useState<"active" | "cancelled">("active");
  const [toCancel, setToCancel] = useState<Registration | null>(null);
  const [form, setForm] = useState({ name: "", email: "", guest: false });
  const [formError, setFormError] = useState<string | null>(null);
  const key = ["registrations", accountId, occurrence?.id];

  const query = useQuery({
    queryKey: key,
    enabled: !!occurrence,
    queryFn: async () => unwrap(await api.GET("/v1/occurrences/{id}/registrations", { params: { path: { id: occurrence!.id } } })).items,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["occurrences", accountId, event.id] });
    void qc.invalidateQueries({ queryKey: ["audit", accountId] });
  };
  const problemText = (e: unknown) =>
    e instanceof ApiProblem && ["full", "already_registered", "registration_closed", "validation_failed"].includes(e.code)
      ? t(`registrations.errors.${e.code}`)
      : t("error.generic");

  const add = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/v1/occurrences/{id}/registrations", {
        params: { path: { id: occurrence!.id } },
        body: { name: form.name, email: form.email, partySize: form.guest ? 2 : 1 },
      })),
    onSuccess: (r) => {
      toast.success(t("registrations.added", { name: r.name }));
      setForm({ name: "", email: "", guest: false });
      setFormError(null);
      refresh();
    },
    onError: (e) => setFormError(problemText(e)),
  });
  const cancel = useMutation({
    mutationFn: async (r: Registration) => unwrap(await api.POST("/v1/registrations/{id}/cancel", { params: { path: { id: r.id } } })),
    onSuccess: (r) => {
      toast.success(t("registrations.cancelledToast", { name: r.name }));
      setToCancel(null);
      refresh();
    },
    onError: (e) => toast.error(problemText(e)),
  });

  const all = query.data ?? [];
  const active = all.filter((r) => r.status !== "cancelled");
  const rows = show === "active" ? active : all.filter((r) => r.status === "cancelled");
  const people = active.reduce((n, r) => n + r.partySize, 0);
  const pool = occurrence?.pool;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  const columns: ColumnDef<Registration>[] = [
    {
      id: "name",
      header: t("registrations.name"),
      cell: ({ row }) => (
        <div className="grid">
          <span className="font-medium">{row.original.name}</span>
          <span className="text-muted-foreground text-xs">{row.original.email}</span>
        </div>
      ),
    },
    { id: "party", header: t("registrations.party"), cell: ({ row }) => <span className="tabular-nums">{row.original.partySize}</span> },
    { id: "source", header: t("registrations.source"), cell: ({ row }) => <Badge variant="outline">{t(`registrations.sources.${row.original.source}`)}</Badge> },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("common.actions")}</span>,
      cell: ({ row }) =>
        row.original.status !== "cancelled" ? (
          <div className="flex justify-end">
            <Button variant="ghost" size="icon" aria-label={t("registrations.cancelFor", { name: row.original.name })} onClick={() => setToCancel(row.original)}>
              <X />
            </Button>
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">{t(`registrations.cancelledBy.${row.original.cancelledBy ?? "staff"}`)}</span>
        ),
    },
  ];

  return (
    <>
      <Sheet open={!!occurrence} onOpenChange={(o) => !o && onClose()}>
        <SheetContent className="sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("registrations.title")}</SheetTitle>
            <SheetDescription>{label}</SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4 pb-6">
            <p className="text-sm" aria-live="polite">
              {t("registrations.summary", { count: active.length, people })}
              {pool && pool.bookableLimit !== null && <> · {t("occurrences.placesOf", { taken: pool.taken + pool.held, limit: pool.bookableLimit })}</>}
            </p>
            {ATTENDEE_URL && event.status === "published" && event.registration.accessPolicy === "open" && occurrence && (
              <a className="text-sm underline underline-offset-4 inline-flex items-center gap-1" href={`${ATTENDEE_URL}/r/${occurrence.id}`} target="_blank" rel="noreferrer">
                {t("registrations.openPage")} <ExternalLink className="size-3.5" />
              </a>
            )}
            <Tabs value={show} onValueChange={(v) => setShow(v as "active" | "cancelled")}>
              <TabsList>
                <TabsTrigger value="active">{t("registrations.active")} ({active.length})</TabsTrigger>
                <TabsTrigger value="cancelled">{t("registrations.cancelled")} ({all.length - active.length})</TabsTrigger>
              </TabsList>
            </Tabs>
            <DataTable columns={columns} data={rows} loading={query.isLoading} empty={t("registrations.empty")} getRowId={(r) => r.id} />

            <form onSubmit={submit} className="grid gap-3 rounded-lg border p-4" aria-labelledby="add-registration">
              <h3 id="add-registration" className="text-sm font-medium">{t("registrations.add")}</h3>
              <Field label={t("registrations.name")} htmlFor="reg-name">
                <Input id="reg-name" required maxLength={200} autoComplete="off" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label={t("registrations.email")} htmlFor="reg-email">
                <Input id="reg-email" type="email" required maxLength={254} autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <div className="flex items-center gap-2">
                <Checkbox id="reg-guest" checked={form.guest} onCheckedChange={(v) => setForm({ ...form, guest: v === true })} />
                <Label htmlFor="reg-guest">{t("registrations.guest")}</Label>
              </div>
              {formError && <p role="alert" className="text-destructive text-sm">{formError}</p>}
              <p className="text-muted-foreground text-xs">{t("registrations.addHelp")}</p>
              <div>
                <Button type="submit" disabled={add.isPending || !form.name.trim() || !form.email.trim()}>
                  <UserPlus /> {t("registrations.addButton")}
                </Button>
              </div>
            </form>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!toCancel} onOpenChange={(o) => !o && setToCancel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("registrations.cancelTitle", { name: toCancel?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("registrations.cancelBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.back")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => toCancel && cancel.mutate(toCancel)} disabled={cancel.isPending}>{t("registrations.cancelConfirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
