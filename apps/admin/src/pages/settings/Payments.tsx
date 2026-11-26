import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Info, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Field } from "@/components/page";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { type Account, ApiProblem, etagOf, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { useAccount } from "../../queries.js";

type Env = "test" | "production";
const emptyKeys = { environment: "test" as Env, merchantSerialNumber: "", clientId: "", clientSecret: "", subscriptionKey: "" };
type Merchant = Account["merchant"];

/**
 * Settings → Payments (docs/checkout.md): connect the account's own Vipps MobilePay merchant,
 * check its keys, disconnect, and the merchant details printed on receipts. Owners change it;
 * everyone can see it.
 */
export function Payments({ canEdit }: { canEdit: boolean }) {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const key = ["payments", accountId];
  const query = useQuery({ queryKey: key, queryFn: async () => unwrap(await api.GET("/v1/payments")) });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const [keys, setKeys] = useState(emptyKeys);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const connect = useMutation({
    mutationFn: async () => unwrap(await api.PUT("/v1/payments/vipps", { body: keys })),
    onSuccess: () => {
      setKeys(emptyKeys);
      setEditing(false);
      toast.success(t("payments.verified"));
      refresh();
    },
  });
  const verify = useMutation({
    mutationFn: async () => unwrap(await api.POST("/v1/payments/vipps/verify")),
    onSuccess: (a) => {
      if (a.status === "active") toast.success(t("payments.verified"));
      refresh();
    },
  });
  const disconnect = useMutation({
    mutationFn: async (version: number) => {
      const r = await api.DELETE("/v1/payments/vipps", { headers: { "If-Match": etagOf(version) } });
      if (r.error) unwrap(r);
    },
    onSuccess: refresh,
    onError: refresh,
  });

  const enable = useMutation({
    mutationFn: async () => unwrap(await api.POST("/v1/payments/checkout")),
    onSuccess: () => {
      toast.success(t("payments.checkoutEnabled"));
      refresh();
      void qc.invalidateQueries({ queryKey: ["sales-channels", accountId] });
      void qc.invalidateQueries({ queryKey: ["sku-mappings", accountId] });
    },
  });

  const vipps = query.data?.vipps ?? null;
  const checkout = query.data?.checkout ?? null;
  const unavailable = query.error instanceof ApiProblem && query.error.code === "conflict";
  const error = connect.error ?? verify.error ?? disconnect.error ?? enable.error;
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  const showForm = canEdit && (!vipps || editing);
  const set = <K extends keyof typeof keys>(k: K, v: (typeof keys)[K]) => setKeys({ ...keys, [k]: v });

  return (
    <Card className="mt-6" id="payments">
      <CardHeader>
        <CardTitle>{t("payments.title")}</CardTitle>
        <CardDescription>{t("payments.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {unavailable && (
          <Alert>
            <Info />
            <AlertDescription>{t("payments.unavailable")}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 font-medium">
              {t("payments.vipps")}
              <Badge variant={vipps?.status === "active" ? "default" : vipps ? "destructive" : "outline"}>{t(`payments.status.${vipps?.status ?? "disconnected"}`)}</Badge>
            </div>
            {vipps && (
              <p className="text-sm text-muted-foreground">
                {t("payments.connectedInfo", { msn: vipps.merchantSerialNumber, env: t(`payments.environments.${vipps.environment}`), date: fmt.format(new Date(vipps.connectedAt)) })}
              </p>
            )}
            {vipps?.statusReason && <p className="text-sm text-destructive">{vipps.statusReason}</p>}
            {vipps && !vipps.webhookRegistered && !vipps.statusReason && <p className="text-sm text-muted-foreground">{t("payments.webhookOff")}</p>}
          </div>
          {canEdit && vipps && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => verify.mutate()} disabled={verify.isPending}>
                <RefreshCw /> {t("payments.verify")}
              </Button>
              {!editing && <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{t("payments.replace")}</Button>}
              <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
                <Unplug /> {t("payments.disconnect")}
              </Button>
            </div>
          )}
        </div>

        {showForm && !unavailable && (
          <form
            className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              connect.mutate();
            }}
          >
            <p className="text-sm text-muted-foreground sm:col-span-2">{t("payments.keysHint")}</p>
            <Field label={t("payments.environment")} htmlFor="vipps-env">
              <Select value={keys.environment} onValueChange={(v) => set("environment", v as Env)}>
                <SelectTrigger id="vipps-env" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="test">{t("payments.environments.test")}</SelectItem>
                  <SelectItem value="production">{t("payments.environments.production")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("payments.msn")} htmlFor="vipps-msn">
              <Input id="vipps-msn" inputMode="numeric" pattern="[0-9]{4,10}" required value={keys.merchantSerialNumber} onChange={(e) => set("merchantSerialNumber", e.target.value.trim())} />
            </Field>
            <Field label={t("payments.clientId")} htmlFor="vipps-client">
              <Input id="vipps-client" required autoComplete="off" value={keys.clientId} onChange={(e) => set("clientId", e.target.value)} />
            </Field>
            <Field label={t("payments.clientSecret")} htmlFor="vipps-secret">
              <Input id="vipps-secret" type="password" required autoComplete="new-password" value={keys.clientSecret} onChange={(e) => set("clientSecret", e.target.value)} />
            </Field>
            <Field label={t("payments.subscriptionKey")} htmlFor="vipps-sub">
              <Input id="vipps-sub" type="password" required autoComplete="new-password" value={keys.subscriptionKey} onChange={(e) => set("subscriptionKey", e.target.value)} />
            </Field>
            <div className="flex items-end gap-2">
              <Button type="submit" disabled={connect.isPending}>{t("payments.connect")}</Button>
              {editing && <Button type="button" variant="ghost" onClick={() => { setEditing(false); setKeys(emptyKeys); }}>{t("common.cancel")}</Button>}
            </div>
          </form>
        )}

        {vipps && (
          <div className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">{t("payments.checkout")}</p>
              <p className="text-sm text-muted-foreground">{checkout?.active ? t("payments.checkoutOn") : t("payments.checkoutHint")}</p>
            </div>
            {canEdit && !checkout?.active && <Button size="sm" onClick={() => enable.mutate()} disabled={enable.isPending}>{t("payments.enableCheckout")}</Button>}
          </div>
        )}

        <MerchantDetails canEdit={canEdit} />
      </CardContent>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("payments.disconnectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("payments.disconnectBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => vipps && disconnect.mutate(vipps.version)}>{t("payments.disconnect")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function MerchantDetails({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const account = useAccount();
  const [form, setForm] = useState<Merchant | null>(null);
  useEffect(() => {
    if (account.data) setForm(account.data.account.merchant);
  }, [account.data]);
  const save = useMutation({
    mutationFn: async (merchant: Merchant) => {
      const r = await api.PATCH("/v1/account", { body: { merchant }, headers: { "If-Match": account.data!.etag } });
      return { account: unwrap(r), etag: r.response.headers.get("etag") ?? "" };
    },
    onSuccess: (data) => {
      qc.setQueryData(["account", accountId], data);
      toast.success(t("common.saved"));
    },
  });
  if (!form) return null;
  const set = <K extends keyof Merchant>(k: K, v: Merchant[K]) => setForm({ ...form, [k]: v });
  const text = (v: string) => (v.trim() ? v : null);

  return (
    <form
      className="grid gap-4 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(form);
      }}
    >
      <div>
        <p className="text-sm font-medium">{t("payments.merchant")}</p>
        <p className="text-sm text-muted-foreground">{t("payments.merchantHint")}</p>
      </div>
      {save.error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
      <Field label={t("payments.legalName")} htmlFor="merchant-name">
        <Input id="merchant-name" maxLength={200} value={form.legalName ?? ""} onChange={(e) => set("legalName", text(e.target.value))} disabled={!canEdit} />
      </Field>
      <Field label={t("payments.orgNumber")} htmlFor="merchant-org">
        <Input id="merchant-org" inputMode="numeric" className="w-48" value={form.orgNumber ?? ""} onChange={(e) => set("orgNumber", text(e.target.value))} disabled={!canEdit} />
      </Field>
      <Field label={t("payments.address")} htmlFor="merchant-address">
        <Textarea id="merchant-address" maxLength={500} rows={2} value={form.address ?? ""} onChange={(e) => set("address", text(e.target.value))} disabled={!canEdit} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={form.vatRegistered} onCheckedChange={(v) => set("vatRegistered", v)} disabled={!canEdit} />
        {t("payments.vatRegistered")}
      </label>
      {canEdit && <div><Button type="submit" disabled={save.isPending}>{t("common.save")}</Button></div>}
    </form>
  );
}
