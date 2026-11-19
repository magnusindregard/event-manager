import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { etagOf, type SalesChannel, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { useSalesChannels, useSkuMappings, useVatClasses } from "../../queries.js";

type Kind = SalesChannel["kind"];
type Patch = { name?: string; holdMinutes?: number; sendTickets?: boolean; active?: boolean };

/**
 * Sales channels (docs/ticketing.md, "Sales channel"): the account's web shop and POS. Each
 * channel's connector authenticates with a channel key; changing channels is owner only.
 */
export function SalesChannels({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const query = useSalesChannels();
  const [draft, setDraft] = useState<{ code: string; name: string; kind: Kind }>({ code: "", name: "", kind: "ecom" });
  const [holds, setHolds] = useState<Record<string, string>>({});
  const [keysFor, setKeysFor] = useState<SalesChannel | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["sales-channels", accountId] });
    void qc.invalidateQueries({ queryKey: ["offers", accountId] });
  };

  const create = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/v1/sales-channels", { body: { code: draft.code.trim(), name: draft.name.trim(), kind: draft.kind }, headers: { "Idempotency-Key": crypto.randomUUID() } })),
    onSuccess: () => {
      setDraft({ code: "", name: "", kind: "ecom" });
      toast.success(t("common.saved"));
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: async ({ c, body }: { c: SalesChannel; body: Patch }) =>
      unwrap(await api.PATCH("/v1/sales-channels/{id}", { params: { path: { id: c.id } }, body, headers: { "If-Match": etagOf(c.version) } })),
    onSuccess: (c) => {
      setHolds(({ [c.id]: _, ...rest }) => rest);
      toast.success(t("common.saved"));
      refresh();
    },
  });
  const error = create.error ?? update.error;
  const validHold = (s: string) => /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 60;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>{t("channels.title")}</CardTitle>
        <CardDescription>{t("channels.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>{t("channels.name")}</TableHead>
                <TableHead>{t("channels.kind")}</TableHead>
                <TableHead>{t("channels.hold")}</TableHead>
                <TableHead>{t("channels.sendTickets")}</TableHead>
                <TableHead>{t("channels.active")}</TableHead>
                {canEdit && <TableHead className="w-12"><span className="sr-only">{t("channels.keys")}</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((c) => {
                const hold = holds[c.id] ?? String(c.holdMinutes);
                return (
                  <TableRow key={c.id} className={c.active ? "" : "text-muted-foreground"}>
                    <TableCell>
                      <div className="font-medium">{c.name}</div>
                      <code className="text-xs">{c.code}</code>
                    </TableCell>
                    <TableCell><Badge variant="outline">{t(`channels.kinds.${c.kind}`)}</Badge></TableCell>
                    <TableCell>
                      {canEdit ? (
                        <div className="flex items-center gap-1">
                          <Input aria-label={`${t("channels.hold")} ${c.code}`} type="number" min={1} max={60} className="w-16" value={hold}
                            aria-invalid={!validHold(hold)} onChange={(e) => setHolds({ ...holds, [c.id]: e.target.value })}
                            onBlur={() => validHold(hold) && Number(hold) !== c.holdMinutes && update.mutate({ c, body: { holdMinutes: Number(hold) } })} />
                          <span className="text-xs text-muted-foreground">{t("channels.min")}</span>
                        </div>
                      ) : t("channels.minutes", { count: c.holdMinutes })}
                    </TableCell>
                    <TableCell>
                      <Switch checked={c.sendTickets} disabled={!canEdit || update.isPending} aria-label={`${t("channels.sendTickets")} ${c.code}`}
                        onCheckedChange={(on) => update.mutate({ c, body: { sendTickets: on } })} />
                    </TableCell>
                    <TableCell>
                      <Switch checked={c.active} disabled={!canEdit || update.isPending} aria-label={`${t("channels.active")} ${c.code}`}
                        onCheckedChange={(on) => update.mutate({ c, body: { active: on } })} />
                    </TableCell>
                    {canEdit && (
                      <TableCell>
                        <Button size="icon" variant="ghost" aria-label={`${t("channels.keys")} ${c.name}`} title={t("channels.keys")} onClick={() => setKeysFor(c)}><KeyRound /></Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
              {query.data?.length === 0 && (
                <TableRow><TableCell colSpan={canEdit ? 6 : 5} className="h-16 text-center text-muted-foreground">{t("channels.empty")}</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {canEdit && (
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Input aria-label={t("channels.code")} placeholder={t("channels.codePlaceholder")} required pattern="[a-z0-9][a-z0-9_\-]*" className="sm:w-36"
              value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toLowerCase() })} />
            <Input aria-label={t("channels.name")} placeholder={t("channels.namePlaceholder")} required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as Kind })}>
              <SelectTrigger aria-label={t("channels.kind")} className="w-full sm:w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ecom">{t("channels.kinds.ecom")}</SelectItem>
                <SelectItem value="pos">{t("channels.kinds.pos")}</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" disabled={create.isPending}><Plus /> {t("channels.add")}</Button>
          </form>
        )}
        <p className="text-xs text-muted-foreground">{t("channels.hint")}</p>
      </CardContent>
      {keysFor && <ChannelKeys channel={keysFor} onClose={() => setKeysFor(null)} />}
    </Card>
  );
}

/** A channel's keys. The full key is shown once, right after creation. */
function ChannelKeys({ channel, onClose }: { channel: SalesChannel; onClose(): void }) {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const key = ["channel-keys", accountId, channel.id];
  const query = useQuery({ queryKey: key, queryFn: async () => unwrap(await api.GET("/v1/sales-channels/{id}/keys", { params: { path: { id: channel.id } } })).items });
  const create = useMutation({
    mutationFn: async () => unwrap(await api.POST("/v1/sales-channels/{id}/keys", { params: { path: { id: channel.id } }, body: { label: label.trim() } })),
    onSuccess: (k) => {
      setSecret(k.secret);
      setLabel("");
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({
    mutationFn: async (keyId: string) => {
      const r = await api.DELETE("/v1/sales-channels/{id}/keys/{keyId}", { params: { path: { id: channel.id, keyId } } });
      if (r.error) unwrap(r);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  const error = create.error ?? revoke.error;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("channels.keysTitle", { name: channel.name })}</DialogTitle>
          <DialogDescription>{t("channels.keysHint")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        {secret && (
          <Alert>
            <KeyRound />
            <AlertTitle>{t("apiKeys.copyNow")}</AlertTitle>
            <AlertDescription className="space-y-2">
              <code className="block break-all rounded bg-muted px-2 py-1 text-xs text-foreground">{secret}</code>
              <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(secret).then(() => toast.success(t("apiKeys.copied")))}>
                <Copy /> {t("apiKeys.copy")}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {channel.active ? (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Input aria-label={t("apiKeys.label")} placeholder={t("channels.keyLabelPlaceholder")} required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} />
            <Button type="submit" disabled={create.isPending || !label.trim()}><Plus /> {t("apiKeys.create")}</Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{t("channels.inactiveKeys")}</p>
        )}
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableBody>
              {(query.data ?? []).map((k) => (
                <TableRow key={k.id} className={k.revokedAt ? "text-muted-foreground" : ""}>
                  <TableCell>
                    <div className="font-medium">{k.label}</div>
                    <code className="text-xs">{k.prefix}_…</code>
                    {k.revokedAt && <Badge variant="secondary" className="ml-2">{t("apiKeys.revoked")}</Badge>}
                  </TableCell>
                  <TableCell>{fmt.format(new Date(k.createdAt))}</TableCell>
                  <TableCell className="w-12">
                    {!k.revokedAt && (
                      <Button variant="ghost" size="icon" aria-label={`${t("apiKeys.revoke")} ${k.label}`} disabled={revoke.isPending} onClick={() => revoke.mutate(k.id)}>
                        <Trash2 />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {query.data?.length === 0 && (
                <TableRow><TableCell colSpan={3} className="h-12 text-center text-muted-foreground">{t("apiKeys.empty")}</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The SKU mapping (docs/ticketing.md, "SKU mapping"): the shop's product for a ticket line, per
 * VAT class and channel. A ticket type cannot be sold in a channel where its class has no SKU.
 */
export function SkuMappings({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const channels = (useSalesChannels().data ?? []).filter((c) => c.active);
  const vat = (useVatClasses().data ?? []).filter((v) => !v.archived || v.inUse);
  const mappings = useSkuMappings();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const stored = (vatClassId: string, channelId: string) => mappings.data?.find((m) => m.vatClassId === vatClassId && m.channelId === channelId)?.externalSku ?? "";
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["sku-mappings", accountId] });
    void qc.invalidateQueries({ queryKey: ["offers", accountId] });
  };
  const save = useMutation({
    mutationFn: async ({ vatClassId, channelId, sku }: { vatClassId: string; channelId: string; sku: string }) => {
      const path = { vatClassId, channelId };
      if (sku) return unwrap(await api.PUT("/v1/sku-mappings/{vatClassId}/{channelId}", { params: { path }, body: { externalSku: sku } }));
      const r = await api.DELETE("/v1/sku-mappings/{vatClassId}/{channelId}", { params: { path } });
      if (r.error) unwrap(r);
      return null;
    },
    onSuccess: (_r, v) => {
      setEdits(({ [`${v.vatClassId}|${v.channelId}`]: _, ...rest }) => rest);
      toast.success(t("common.saved"));
      refresh();
    },
  });

  if (!channels.length || !vat.length) return null;
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>{t("skus.title")}</CardTitle>
        <CardDescription>{t("skus.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {save.error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{save.error.message}</AlertDescription>
          </Alert>
        )}
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>{t("skus.vatClass")}</TableHead>
                {channels.map((c) => <TableHead key={c.id}>{c.name}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {vat.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>{v.label} <span className="text-muted-foreground">({v.ratePct} %)</span></TableCell>
                  {channels.map((c) => {
                    const k = `${v.id}|${c.id}`;
                    const current = stored(v.id, c.id);
                    const value = edits[k] ?? current;
                    return (
                      <TableCell key={c.id}>
                        {canEdit ? (
                          <Input aria-label={t("skus.cell", { vat: v.label, channel: c.name })} className="min-w-36 font-mono text-xs" maxLength={100} value={value}
                            placeholder={t("skus.missing")} onChange={(e) => setEdits({ ...edits, [k]: e.target.value })}
                            onBlur={() => value.trim() !== current && save.mutate({ vatClassId: v.id, channelId: c.id, sku: value.trim() })} />
                        ) : current ? <code className="text-xs">{current}</code> : <span className="text-muted-foreground">{t("skus.missing")}</span>}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">{t("skus.hint")}</p>
      </CardContent>
    </Card>
  );
}
