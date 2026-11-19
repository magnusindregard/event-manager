import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { etagOf, unwrap, type VatClass } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { useVatClasses } from "../../queries.js";

const parseRate = (s: string) => {
  const n = Number(s.trim().replace(",", "."));
  return s.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : null;
};

/**
 * VAT classes for ticket offers (docs/ticketing.md). Set up with the account's accountant; a rate
 * in use by an offer is fixed, so a changed rate is a new class that the offers move to.
 */
export function VatClasses({ canEdit }: { canEdit: boolean }) {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const query = useVatClasses();
  const [draft, setDraft] = useState({ code: "", label: "", rate: "" });
  const [edits, setEdits] = useState<Record<string, { label: string; rate: string }>>({});
  const refresh = () => void qc.invalidateQueries({ queryKey: ["vat-classes", accountId] });

  const create = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/v1/vat-classes", { body: { code: draft.code.trim(), label: draft.label.trim(), ratePct: parseRate(draft.rate) ?? 0 }, headers: { "Idempotency-Key": crypto.randomUUID() } })),
    onSuccess: () => {
      setDraft({ code: "", label: "", rate: "" });
      toast.success(t("common.saved"));
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: async ({ v, body }: { v: VatClass; body: { label?: string; ratePct?: number; archived?: boolean } }) =>
      unwrap(await api.PATCH("/v1/vat-classes/{id}", { params: { path: { id: v.id } }, body, headers: { "If-Match": etagOf(v.version) } })),
    onSuccess: (v) => {
      setEdits(({ [v.id]: _, ...rest }) => rest);
      toast.success(t("common.saved"));
      refresh();
    },
  });
  const error = create.error ?? update.error;
  const pct = (n: number) => `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(n)} %`;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>{t("vat.title")}</CardTitle>
        <CardDescription>{t("vat.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>{t("vat.code")}</TableHead>
                <TableHead>{t("vat.label")}</TableHead>
                <TableHead className="w-32">{t("vat.rate")}</TableHead>
                <TableHead className="w-28">{t("vat.active")}</TableHead>
                {canEdit && <TableHead className="w-20"><span className="sr-only">{t("common.save")}</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((v) => {
                const e = edits[v.id] ?? { label: v.label, rate: String(v.ratePct) };
                const rate = parseRate(e.rate);
                const dirty = e.label.trim() !== v.label || rate !== v.ratePct;
                const set = (patch: Partial<typeof e>) => setEdits({ ...edits, [v.id]: { ...e, ...patch } });
                return (
                  <TableRow key={v.id} className={v.archived ? "text-muted-foreground" : ""}>
                    <TableCell><code className="text-xs">{v.code}</code></TableCell>
                    <TableCell>
                      {canEdit ? <Input aria-label={`${t("vat.label")} ${v.code}`} value={e.label} onChange={(x) => set({ label: x.target.value })} /> : v.label}
                    </TableCell>
                    <TableCell>
                      {canEdit && !v.inUse ? (
                        <Input aria-label={`${t("vat.rate")} ${v.code}`} inputMode="decimal" className="w-24" value={e.rate} onChange={(x) => set({ rate: x.target.value })} />
                      ) : (
                        <span title={v.inUse ? t("vat.rateFixed") : undefined}>{pct(v.ratePct)}{v.inUse && <Badge variant="outline" className="ml-2 font-normal">{t("vat.inUse")}</Badge>}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Switch checked={!v.archived} disabled={!canEdit || update.isPending} aria-label={`${t("vat.active")} ${v.code}`}
                        onCheckedChange={(on) => update.mutate({ v, body: { archived: !on } })} />
                    </TableCell>
                    {canEdit && (
                      <TableCell>
                        <Button size="sm" variant="outline" disabled={!dirty || rate === null || !e.label.trim() || update.isPending}
                          onClick={() => update.mutate({ v, body: { label: e.label.trim(), ...(v.inUse ? {} : { ratePct: rate! }) } })}>
                          {t("common.save")}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
              {query.data?.length === 0 && (
                <TableRow><TableCell colSpan={canEdit ? 5 : 4} className="h-16 text-center text-muted-foreground">{t("vat.empty")}</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {canEdit && (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Input aria-label={t("vat.code")} placeholder={t("vat.codePlaceholder")} required pattern="[a-z0-9][a-z0-9_\-]*" className="sm:w-40"
              value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toLowerCase() })} />
            <Input aria-label={t("vat.label")} placeholder={t("vat.label")} required value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            <Input aria-label={t("vat.rate")} placeholder={t("vat.rate")} required inputMode="decimal" className="sm:w-28"
              value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: e.target.value })} />
            <Button type="submit" disabled={create.isPending || parseRate(draft.rate) === null}><Plus /> {t("vat.add")}</Button>
          </form>
        )}
        <p className="text-xs text-muted-foreground">{t("vat.hint")}</p>
      </CardContent>
    </Card>
  );
}
