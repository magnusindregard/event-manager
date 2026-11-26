import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, ExternalLink, Pencil, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Field } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiProblem, type CatalogEvent, etagOf, type EventSending as Sending, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";

// Event → Guest list → "Invitations sent from" (docs/hubspot.md, "HubSpot sending"): who sends
// the event's invitations, reminders and welcome; on HubSpot, how many guests would become
// marketing contacts, and the event's own emails in HubSpot with their subject and preview text.
// Shown only when the account has HubSpot connected.

type Kind = "invitation" | "reminder" | "welcome";
type Patch = {
  channel?: Sending["channel"];
  templates?: Partial<Record<Kind, string | null>>;
  texts?: Partial<Record<Kind, { subject: string; previewText?: string } | null>>;
};
const NONE = "__default";

export function EventSending({ event }: { event: CatalogEvent }) {
  const { t, i18n } = useTranslation();
  const { api, accountId, can } = useApp();
  const qc = useQueryClient();
  const canWrite = can("registrations.write");
  const [editing, setEditing] = useState<Kind | null>(null);
  const integrations = useQuery({ queryKey: ["integrations", accountId], queryFn: async () => unwrap(await api.GET("/v1/integrations")) });
  const hubspot = integrations.data?.items.find((c) => c.provider === "hubspot" && c.status !== "disconnected");
  const key = ["event-sending", accountId, event.id];
  const query = useQuery({
    queryKey: key,
    enabled: !!hubspot,
    queryFn: async () => unwrap(await api.GET("/v1/events/{id}/sending", { params: { path: { id: event.id } } })),
    // While the worker makes the emails or counts the guests, look again now and then.
    refetchInterval: (q) => {
      const d = q.state.data;
      return d?.channel === "hubspot" && (d.emails.some((e) => e.status === "pending") || d.emails.length === 0 || !d.marketingCheck) ? 3000 : false;
    },
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const save = useMutation({
    mutationFn: async (body: Patch) =>
      unwrap(await api.PATCH("/v1/events/{id}/sending", { params: { path: { id: event.id } }, body, headers: { "If-Match": etagOf(query.data?.version ?? 0) } })),
    onSuccess: (s) => {
      qc.setQueryData(key, s);
      toast.success(t("common.saved"));
      setEditing(null);
    },
    onError: (e) => {
      toast.error(e instanceof ApiProblem && ["conflict", "validation_failed", "version_conflict"].includes(e.code) ? e.message : t("error.generic"));
      refresh();
    },
  });
  const check = useMutation({
    mutationFn: async () => {
      const r = await api.POST("/v1/events/{id}/sending/check", { params: { path: { id: event.id } } });
      if (r.error) unwrap(r);
    },
    onSuccess: () => setTimeout(refresh, 1500),
  });

  if (!hubspot || !query.data) return null;
  const s: Sending = query.data;
  const onHubSpot = s.channel === "hubspot";
  const templates = hubspot.sending.templates;
  const fmt = new Intl.DateTimeFormat(i18n.language === "nb" ? "nb-NO" : "en-GB", { dateStyle: "short", timeStyle: "short" });
  const kinds: Kind[] = event.registration.reminderMinBefore !== null ? ["invitation", "reminder", "welcome"] : ["invitation", "reminder"];
  const templateName = (id: string | null) => templates.find((x) => x.id === id)?.name ?? (id ? `#${id}` : t("eventSending.noTemplate"));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("eventSending.title")}</CardTitle>
        <CardDescription>{t("eventSending.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Field label={t("eventSending.channel")} htmlFor="sending-channel" hint={s.locked ? t("eventSending.locked") : undefined}>
          <Select value={s.channel} disabled={!canWrite || s.locked || save.isPending} onValueChange={(v) => save.mutate({ channel: v as Sending["channel"] })}>
            <SelectTrigger id="sending-channel" className="w-full sm:w-72"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="platform">{t("eventSending.platform")}</SelectItem>
              <SelectItem value="hubspot" disabled={!!s.hubspotBlocker && !onHubSpot}>{t("eventSending.hubspot")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {s.hubspotBlocker && (
          <Alert>
            <CircleAlert />
            <AlertDescription>{s.hubspotBlocker}</AlertDescription>
          </Alert>
        )}

        {onHubSpot && (
          <>
            <div className="grid gap-1 text-sm">
              {s.marketingCheck ? (
                s.marketingCheck.error ? (
                  <p className="text-destructive">{s.marketingCheck.error}</p>
                ) : (
                  <p>
                    {t("eventSending.check", { wouldBecome: s.marketingCheck.wouldBecome, guests: s.marketingCheck.guests })}
                    {s.marketingCheck.plusAddresses > 0 && ` ${t("eventSending.plus", { count: s.marketingCheck.plusAddresses })}`}
                    <span className="text-muted-foreground"> · {t("eventSending.checkedAt", { date: fmt.format(new Date(s.marketingCheck.checkedAt)) })}</span>
                  </p>
                )
              ) : (
                <p className="text-muted-foreground">{t("eventSending.checking")}</p>
              )}
              <p className="text-muted-foreground">{t("eventSending.billing")}</p>
              <div>
                <Button size="sm" variant="outline" onClick={() => check.mutate()} disabled={check.isPending}><RefreshCw /> {t("eventSending.checkAgain")}</Button>
              </div>
            </div>

            <ul className="grid gap-3">
              {kinds.map((kind) => {
                const e = s.emails.find((x) => x.kind === kind);
                const sent = !!e?.firstSentAt;
                return (
                  <li key={kind} className="grid gap-1 rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{t(`eventSending.kinds.${kind}`)}</span>
                      <Badge variant={e?.status === "failed" ? "destructive" : e?.status === "ready" ? "secondary" : "outline"}>
                        {t(`eventSending.status.${e?.status ?? "pending"}`)}
                      </Badge>
                      {sent && <Badge variant="outline">{t("eventSending.sentFrom")}</Badge>}
                      {e?.url && (
                        <a className="inline-flex items-center gap-1 text-xs underline" href={e.url} target="_blank" rel="noreferrer">
                          <ExternalLink className="size-3" /> {t("eventSending.openInHubSpot")}
                        </a>
                      )}
                      {canWrite && !sent && (
                        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing(kind)}><Pencil /> {t("eventSending.edit")}</Button>
                      )}
                    </div>
                    <div>{s.texts[kind].subject}</div>
                    {s.texts[kind].previewText && <div className="text-muted-foreground">{s.texts[kind].previewText}</div>}
                    <div className="text-xs text-muted-foreground">
                      {t("eventSending.template", { name: templateName(s.effectiveTemplates[kind]) })}
                      {!s.templates[kind] && s.effectiveTemplates[kind] ? ` (${t("eventSending.accountDefault")})` : ""}
                    </div>
                    {e?.error && <p className="text-xs text-destructive">{e.error}</p>}
                    {e?.warnings.map((w) => <p key={w} className="text-xs text-destructive">{w}</p>)}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {editing && (
          <EditEmail
            kind={editing}
            sending={s}
            templates={templates}
            pending={save.isPending}
            onClose={() => setEditing(null)}
            onSave={(body) => save.mutate(body)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function EditEmail({ kind, sending, templates, pending, onClose, onSave }: {
  kind: Kind;
  sending: Sending;
  templates: { id: string; name: string }[];
  pending: boolean;
  onClose: () => void;
  onSave: (body: Patch) => void;
}) {
  const { t } = useTranslation();
  const [subject, setSubject] = useState(sending.texts[kind].subject);
  const [preview, setPreview] = useState(sending.texts[kind].previewText);
  const [template, setTemplate] = useState(sending.templates[kind] ?? NONE);
  useEffect(() => {
    setSubject(sending.texts[kind].subject);
    setPreview(sending.texts[kind].previewText);
  }, [sending, kind]);
  const submit = () =>
    onSave({
      templates: { [kind]: template === NONE ? null : template },
      texts: { [kind]: { subject, previewText: preview } },
    });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(`eventSending.kinds.${kind}`)}</DialogTitle>
          <DialogDescription>{t("eventSending.editHint")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label={t("eventSending.templateLabel")} htmlFor="email-template">
            <Select value={template} onValueChange={setTemplate}>
              <SelectTrigger id="email-template" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("eventSending.useDefault")}</SelectItem>
                {templates.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("eventSending.subject")} htmlFor="email-subject">
            <Input id="email-subject" maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label={t("eventSending.previewText")} htmlFor="email-preview">
            <Input id="email-preview" maxLength={300} value={preview} onChange={(e) => setPreview(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={submit} disabled={pending || !subject.trim()}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
