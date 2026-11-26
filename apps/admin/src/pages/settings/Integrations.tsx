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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
    refetchInterval: (q) => (q.state.data?.items.some((c) => c.status === "active" && (c.setup.status === "pending" || c.cleanup.disconnectRequestedAt)) ? 3000 : false),
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
  const cleanupAndDisconnect = useMutation({
    mutationFn: async () => unwrap(await api.POST("/v1/integrations/hubspot/cleanup-and-disconnect")),
    onSuccess: () => {
      toast.success(t("integrations.cleanup.disconnectQueued"));
      refresh();
    },
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
  const error = connect.error ?? repair.error ?? disconnect.error ?? settings.error ?? cleanupAndDisconnect.error;
  // How many contacts a plain disconnect leaves in the portal, from the sync log.
  const pendingCleanup = (qc.getQueryData(syncKey(accountId)) as IntegrationSync | undefined)?.cleanup.pending ?? 0;
  const cleaningUp = !!live?.cleanup.disconnectRequestedAt;

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
                <Button variant="outline" onClick={() => setConfirm(true)} disabled={disconnect.isPending || cleaningUp}>
                  <Unplug /> {t("integrations.disconnect")}
                </Button>
              )}
            </div>
          )}
        </div>

        {!available && !live && <p className="text-sm text-muted-foreground">{t("integrations.notAvailable")}</p>}

        {cleaningUp && (
          <Alert>
            <RefreshCw className="animate-spin" />
            <AlertDescription>{t("integrations.cleanup.running")}</AlertDescription>
          </Alert>
        )}

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
              <div className="flex items-center gap-2 text-sm">
                {t("integrations.featureSending")}
                <Badge variant="outline">{live.features.sending ? t("integrations.featureOn") : t("integrations.featureOff")}</Badge>
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
            <CleanupSettings live={live} canEdit={canEdit} pending={settings.isPending} save={(body) => settings.mutate({ c: live, body })} />
            <SendingSettings live={live} canEdit={canEdit} pending={settings.isPending} save={(body) => settings.mutate({ c: live, body })} />
          </>
        )}

        {live && <SyncLog live={live} canEdit={canEdit} />}

        <AlertDialog open={confirm} onOpenChange={setConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("integrations.disconnect")}</AlertDialogTitle>
              <AlertDialogDescription>{t("integrations.disconnectConfirm")}</AlertDialogDescription>
              {pendingCleanup > 0 && <AlertDialogDescription>{t("integrations.cleanup.disconnectLeaves", { count: pendingCleanup })}</AlertDialogDescription>}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              {live?.status === "active" && (
                <AlertDialogAction onClick={() => cleanupAndDisconnect.mutate()}>{t("integrations.cleanup.andDisconnect")}</AlertDialogAction>
              )}
              <AlertDialogAction variant="outline" onClick={() => disconnect.mutate()}>{t("integrations.disconnect")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

const NONE = "__none";

/**
 * The cleanup after HubSpot sending (docs/hubspot.md, milestone 4): which cleanup scopes are
 * missing, the event subscription type, the grace period, whether mirrored contacts are deleted,
 * and the state of the workflow that sets contacts back to non-marketing.
 */
function CleanupSettings({ live, canEdit, pending, save }: { live: Integration; canEdit: boolean; pending: boolean; save: (body: Partial<Integration["settings"]>) => void }) {
  const { t } = useTranslation();
  const [grace, setGrace] = useState(String(live.settings.cleanupGraceDays));
  useEffect(() => setGrace(String(live.settings.cleanupGraceDays)), [live.settings.cleanupGraceDays]);
  const c = live.cleanup;
  const types = c.subscriptionTypes.filter((x) => x.active || x.id === live.settings.eventSubscriptionTypeId);
  const commitGrace = () => {
    const n = Number(grace);
    if (Number.isInteger(n) && n >= 0 && n <= 90 && n !== live.settings.cleanupGraceDays) save({ cleanupGraceDays: n });
    else setGrace(String(live.settings.cleanupGraceDays));
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium">{t("integrations.cleanup.title")}</div>
        <p className="text-sm text-muted-foreground">{t("integrations.cleanup.hint")}</p>
      </div>
      {c.missingScopes.length > 0 && (
        <Alert>
          <CircleAlert />
          <AlertDescription>{t("integrations.cleanup.missingScopes", { scopes: c.missingScopes.join(", ") })}</AlertDescription>
        </Alert>
      )}
      {c.workflowEnabled === false && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{t("integrations.cleanup.workflowOff")}</AlertDescription>
        </Alert>
      )}
      {!!c.nonMarketingWaiting && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{t("integrations.cleanup.workflowStuck", { count: c.nonMarketingWaiting })}</AlertDescription>
        </Alert>
      )}
      {c.missingScopes.length === 0 && (
        <div className="grid max-w-md gap-1">
          <Label htmlFor="eventSubscriptionTypeId">{t("integrations.cleanup.eventType")}</Label>
          <Select
            value={live.settings.eventSubscriptionTypeId ?? NONE}
            disabled={!canEdit || pending || !types.length}
            onValueChange={(v) => save({ eventSubscriptionTypeId: v === NONE ? null : v })}
          >
            <SelectTrigger id="eventSubscriptionTypeId" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("integrations.cleanup.noEventType")}</SelectItem>
              {types.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("integrations.cleanup.eventTypeHint")}</p>
        </div>
      )}
      <div className="grid max-w-md gap-1">
        <Label htmlFor="cleanupGraceDays">{t("integrations.cleanup.graceDays")}</Label>
        <Input id="cleanupGraceDays" type="number" min={0} max={90} className="w-28" value={grace} disabled={!canEdit || pending}
          onChange={(e) => setGrace(e.target.value)} onBlur={commitGrace} onKeyDown={(e) => e.key === "Enter" && commitGrace()} />
        <p className="text-xs text-muted-foreground">{t("integrations.cleanup.graceDaysHint")}</p>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="deleteMirroredContacts" checked={live.settings.deleteMirroredContacts} disabled={!canEdit || pending}
          onCheckedChange={(v) => save({ deleteMirroredContacts: v })} />
        <Label htmlFor="deleteMirroredContacts">{t("integrations.cleanup.deleteMirrored")}</Label>
      </div>
    </div>
  );
}

const EMAIL_KINDS = ["invitation", "reminder", "welcome"] as const;
const templateKey = { invitation: "invitationTemplateId", reminder: "reminderTemplateId", welcome: "welcomeTemplateId" } as const;

/**
 * HubSpot sending (docs/hubspot.md, milestone 5): what still stops events from sending through
 * HubSpot, and the account's default single-send template per kind, with what is wrong with each.
 */
function SendingSettings({ live, canEdit, pending, save }: { live: Integration; canEdit: boolean; pending: boolean; save: (body: Partial<Integration["settings"]>) => void }) {
  const { t } = useTranslation();
  const s = live.sending;
  const eventType = live.settings.eventSubscriptionTypeId;
  const warningsFor = (kind: (typeof EMAIL_KINDS)[number], id: string | null) => {
    const tpl = s.templates.find((x) => x.id === id);
    if (!tpl) return [];
    const w: string[] = [];
    if (kind !== "welcome" && !tpl.hasInvitationLink) w.push(t("integrations.sending.noInvitationLink"));
    if (kind === "welcome" && !tpl.hasManageLink) w.push(t("integrations.sending.noManageLink"));
    if (eventType && tpl.subscriptionId !== eventType) w.push(t("integrations.sending.otherType"));
    return w;
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium">{t("integrations.sending.title")}</div>
        <p className="text-sm text-muted-foreground">{t("integrations.sending.hint")}</p>
      </div>
      {s.blocker && (
        <Alert>
          <CircleAlert />
          <AlertDescription>{s.blocker}</AlertDescription>
        </Alert>
      )}
      {s.eventTypeUsedBy.length > 0 && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{t("integrations.sending.typeUsedBy", { names: s.eventTypeUsedBy.map((e) => e.name).join(", ") })}</AlertDescription>
        </Alert>
      )}
      {s.templates.length > 0 && EMAIL_KINDS.map((kind) => {
        const value = live.settings[templateKey[kind]];
        const warnings = warningsFor(kind, value);
        return (
          <div key={kind} className="grid max-w-md gap-1">
            <Label htmlFor={`template-${kind}`}>{t(`integrations.sending.template.${kind}`)}</Label>
            <Select value={value ?? NONE} disabled={!canEdit || pending} onValueChange={(v) => save({ [templateKey[kind]]: v === NONE ? null : v })}>
              <SelectTrigger id={`template-${kind}`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("integrations.sending.noTemplate")}</SelectItem>
                {s.templates.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {warnings.map((w) => <p key={w} className="text-xs text-destructive">{w}</p>)}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">{t("integrations.sending.templatesHint")}</p>
    </div>
  );
}

const KINDS = ["contact", "marketing_event", "attendance", "segment", "segment_member"] as const;

/**
 * The sync log (docs/hubspot.md, milestones 2 and 3): what is in step with HubSpot, what waits, and what
 * HubSpot refused with its reason, and what the nightly segment check fixed. Owners can try refused items again, or push everything again
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
          {data && (data.cleanup.pending > 0 || data.cleanup.kept > 0 || data.cleanup.failed > 0 || data.cleanup.last) && (
            <p className="text-sm text-muted-foreground">
              {t("integrations.cleanup.counts", { pending: data.cleanup.pending, kept: data.cleanup.kept })}
              {data.cleanup.failed > 0 && <> {t("integrations.cleanup.failedCount", { count: data.cleanup.failed })}</>}
              {data.cleanup.last && <> {t("integrations.cleanup.last", { date: fmt.format(new Date(data.cleanup.last.at)), deleted: data.cleanup.last.deleted, restored: data.cleanup.last.restored })}</>}
              {data.cleanup.last?.error && <span className="text-destructive"> {data.cleanup.last.error}</span>}
            </p>
          )}
          {data?.lastReconcile && (
            <p className="text-sm text-muted-foreground">
              {t("integrations.log.reconciled", { date: fmt.format(new Date(data.lastReconcile.at)), count: data.lastReconcile.segments })}{" "}
              {data.lastReconcile.added + data.lastReconcile.removed + data.lastReconcile.recreated > 0
                ? t("integrations.log.reconcileFixed", { added: data.lastReconcile.added, removed: data.lastReconcile.removed, recreated: data.lastReconcile.recreated })
                : t("integrations.log.reconcileClean")}
            </p>
          )}
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
