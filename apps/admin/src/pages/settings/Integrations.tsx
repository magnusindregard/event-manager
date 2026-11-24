import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Plug, RefreshCw, RotateCcw, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { etagOf, type Integration, type IntegrationSync, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";

const queryKey = (accountId: string | null) => ["integrations", accountId];
const syncKey = (accountId: string | null) => ["integrations", accountId, "hubspot-sync"];

/**
 * Settings → Integrations (docs/hubspot.md): connect and disconnect HubSpot, see the portal and
 * what its plan allows, choose who is synced. Owners change it; everyone can see it.
 */
export function Integrations({ canEdit }: { canEdit: boolean }) {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const query = useQuery({
    queryKey: queryKey(accountId),
    queryFn: async () => unwrap(await api.GET("/v1/integrations")),
    // While the worker sets up the portal, look again now and then.
    refetchInterval: (q) => (q.state.data?.items.some((c) => c.status === "active" && c.setup.status === "pending") ? 3000 : false),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: queryKey(accountId) });
  const loaded = query.isSuccess;
  // Coming back from HubSpot (/settings#integrations): the card renders after the hash was read.
  useEffect(() => {
    if (loaded && window.location.hash === "#integrations") document.getElementById("integrations")?.scrollIntoView({ block: "start" });
  }, [loaded]);

  const connect = useMutation({
    mutationFn: async () => unwrap(await api.POST("/v1/integrations/hubspot/authorize")),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const repair = useMutation({
    mutationFn: async () => unwrap(await api.POST("/v1/integrations/hubspot/setup")),
    onSuccess: refresh,
  });
  const disconnect = useMutation({
    mutationFn: async () => {
      const r = await api.DELETE("/v1/integrations/hubspot");
      if (r.error) unwrap(r);
    },
    onSuccess: refresh,
  });
  const settings = useMutation({
    mutationFn: async ({ c, body }: { c: Integration; body: Partial<Integration["settings"]> }) =>
      unwrap(await api.PATCH("/v1/integrations/hubspot", { body, headers: { "If-Match": etagOf(c.version) } })),
    onSuccess: () => {
      toast.success(t("common.saved"));
      refresh();
    },
    onError: refresh,
  });

  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  const hubspot = query.data?.items.find((c) => c.provider === "hubspot");
  const live = hubspot && hubspot.status !== "disconnected" ? hubspot : null;
  const available = query.data?.available.hubspot ?? false;
  const error = connect.error ?? repair.error ?? disconnect.error ?? settings.error;

  return (
    <Card className="mt-6" id="integrations">
      <CardHeader>
        <CardTitle>{t("integrations.title")}</CardTitle>
        <CardDescription>{t("integrations.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 font-medium">
              {t("integrations.hubspot")}
              <Badge variant={live?.status === "active" ? "default" : live ? "destructive" : "outline"}>
                {t(`integrations.status.${live?.status ?? "disconnected"}`)}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{t("integrations.hubspotHint")}</p>
            {live && (
              <p className="text-sm text-muted-foreground">
                {t("integrations.portal", { id: live.portalId })} · {t("integrations.connectedAt", { date: fmt.format(new Date(live.connectedAt)) })}
              </p>
            )}
            {!live && hubspot?.disconnectedAt && (
              <p className="text-sm text-muted-foreground">
                {t("integrations.portal", { id: hubspot.portalId })} · {t("integrations.disconnectedAt", { date: fmt.format(new Date(hubspot.disconnectedAt)) })}
              </p>
            )}
          </div>
          {canEdit && available && (
            <div className="flex flex-wrap gap-2">
              {(!live || live.status === "needs_reconnect") && (
                <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
                  <Plug /> {live ? t("integrations.reconnect") : t("integrations.connect")}
                </Button>
              )}
              {live?.status === "active" && (
                <Button variant="outline" onClick={() => repair.mutate()} disabled={repair.isPending || live.setup.status === "pending"}>
                  <RefreshCw /> {t("integrations.repair")}
                </Button>
              )}
              {live && (
                <Button variant="outline" onClick={() => setConfirm(true)} disabled={disconnect.isPending}>
                  <Unplug /> {t("integrations.disconnect")}
                </Button>
              )}
            </div>
          )}
        </div>

        {!available && !live && <p className="text-sm text-muted-foreground">{t("integrations.notAvailable")}</p>}

        {live?.status === "needs_reconnect" && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{t("integrations.needsReconnect")}</AlertDescription>
          </Alert>
        )}

        {live?.status === "active" && (
          <>
            <p className={live.setup.status === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
              {t(`integrations.setup.${live.setup.status}`, { error: live.setup.error ?? "" })}
            </p>
            <div className="space-y-1">
              <div className="text-sm font-medium">{t("integrations.features")}</div>
              <div className="flex items-center gap-2 text-sm">
                {t("integrations.featureCustomEvents")}
                <Badge variant="outline">{live.features.customEvents ? t("integrations.featureOn") : t("integrations.featureOff")}</Badge>
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">{t("integrations.sync")}</div>
              {(["syncInvitedGuests", "syncOpenAttendees"] as const).map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <Switch id={k} checked={live.settings[k]} disabled={!canEdit || settings.isPending}
                    onCheckedChange={(v) => settings.mutate({ c: live, body: { [k]: v } })} />
                  <Label htmlFor={k}>{t(`integrations.${k}`)}</Label>
                </div>
              ))}
            </div>
          </>
        )}

        {live && <SyncLog live={live} canEdit={canEdit} />}

        <AlertDialog open={confirm} onOpenChange={setConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("integrations.disconnect")}</AlertDialogTitle>
              <AlertDialogDescription>{t("integrations.disconnectConfirm")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={() => disconnect.mutate()}>{t("integrations.disconnect")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

const KINDS = ["contact", "marketing_event", "attendance"] as const;

/**
 * The sync log (docs/hubspot.md, milestone 2): what is in step with HubSpot, what waits, and what
 * HubSpot refused with its reason. Owners can try refused items again, or push everything again
 * ("Resync") for a portal where someone deleted or changed what we wrote.
 */
function SyncLog({ live, canEdit }: { live: Integration; canEdit: boolean }) {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: syncKey(accountId),
    queryFn: async () => unwrap(await api.GET("/v1/integrations/hubspot/sync")),
    // While items wait, look again now and then.
    refetchInterval: (q) => (q.state.data && KINDS.some((k) => q.state.data!.counts[k].pending > 0) ? 5000 : false),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: syncKey(accountId) });
  const retry = useMutation({
    mutationFn: async () => unwrap(await api.POST("/v1/integrations/hubspot/sync/retry")),
    onSuccess: ({ retried }) => {
      toast.success(t("integrations.log.retried", { count: retried }));
      refresh();
    },
  });
  const resync = useMutation({
    mutationFn: async () => {
      const r = await api.POST("/v1/integrations/hubspot/resync");
      if (r.error) unwrap(r);
    },
    onSuccess: () => {
      toast.success(t("integrations.log.resyncQueued"));
      // The worker marks everything first; look again shortly.
      setTimeout(refresh, 1500);
    },
  });
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  const data: IntegrationSync | undefined = query.data;
  const error = query.error ?? retry.error ?? resync.error;

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-medium">{t("integrations.log.title")}</div>
          <p className="text-sm text-muted-foreground">
            {data?.lastSyncedAt ? t("integrations.log.lastSynced", { date: fmt.format(new Date(data.lastSyncedAt)) }) : t("integrations.log.never")}
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {!!data?.issues.length && (
              <Button variant="outline" size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}>
                <RotateCcw /> {t("integrations.log.retry")}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => resync.mutate()} disabled={resync.isPending || live.status !== "active"}>
              <RefreshCw /> {t("integrations.log.resync")}
            </Button>
          </div>
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      {data && (
        <ul className="space-y-1 text-sm">
          {KINDS.map((k) => {
            const c = data.counts[k];
            return (
              <li key={k} className="flex flex-wrap items-center gap-x-2">
                <span className="min-w-48 font-medium">{t(`integrations.log.kinds.${k}`)}</span>
                <span className="text-muted-foreground">{t("integrations.log.synced", { count: c.synced })}</span>
                {c.pending > 0 && <Badge variant="outline">{t("integrations.log.pending", { count: c.pending })}</Badge>}
                {c.failed > 0 && <Badge variant="destructive">{t("integrations.log.failed", { count: c.failed })}</Badge>}
              </li>
            );
          })}
        </ul>
      )}
      {!!data?.issues.length && (
        <div className="space-y-1">
          <div className="text-sm font-medium">{t("integrations.log.issues")}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("integrations.log.item")}</TableHead>
                <TableHead>{t("integrations.log.error")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.issues.map((i) => (
                <TableRow key={`${i.kind}:${i.label}:${i.updatedAt}`}>
                  <TableCell className="whitespace-normal align-top">
                    <div className="break-all">{i.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {t(`integrations.log.kinds.${i.kind}`)}
                      {i.startUtc ? ` · ${fmt.format(new Date(i.startUtc))}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal align-top text-sm">
                    {/* The request line says nothing to a manager; HubSpot's own words do. */}
                    {i.lastError.replace(/^HubSpot \S+ \S+: /, "")}
                    <div className="text-xs text-muted-foreground">
                      {i.givenUp ? t("integrations.log.givenUp") : i.attempts === 0 ? t("integrations.log.queued") : t("integrations.log.retrying", { count: i.attempts })} · {t("integrations.log.lastTried", { date: fmt.format(new Date(i.updatedAt)) })}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/**
 * Where HubSpot sends the browser after the install (the app's redirect URL). Posts code and
 * state with the signed-in owner's token, then goes back to the settings.
 */
export function HubSpotCallback() {
  const { t } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [failure, setFailure] = useState<string | null>(null);
  // Once only: a code works one time, and StrictMode runs effects twice in development.
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setFailure(t("integrations.callbackDenied"));
      return;
    }
    void (async () => {
      try {
        unwrap(await api.POST("/v1/integrations/hubspot/callback", { body: { code, state } }));
        toast.success(t("integrations.connected"));
        await qc.invalidateQueries({ queryKey: queryKey(accountId) });
        navigate("/settings#integrations", { replace: true });
      } catch (e) {
        setFailure(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [api, accountId, navigate, params, qc, t]);

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      {failure ? (
        <>
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
          <Button asChild variant="outline">
            <Link to="/settings#integrations">{t("integrations.backToSettings")}</Link>
          </Button>
        </>
      ) : (
        <p className="text-muted-foreground">{t("integrations.callbackWorking")}</p>
      )}
    </div>
  );
}
