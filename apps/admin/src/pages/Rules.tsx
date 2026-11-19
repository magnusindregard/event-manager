import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConflictDialog } from "@/components/conflict-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { type CatalogEvent, etagOf, isConflict, type Rule, type RuleChangeResult, unwrap } from "../api.js";
import { useApp } from "../AppContext.js";
import { formatMoney } from "../lib/money.js";
import { describeConditions, describeEffects } from "../lib/rules.js";
import { locationPath, offerName, useEventOffers, useEventRules, useLocations, useTagLabels, useVocabularies } from "../queries.js";
import { RuleEditor, type RuleEditorMode } from "./schedule/RuleEditor.js";

/** After a save: refresh now, and again shortly if the worker resolves the occurrences. */
export function useRuleRefresh(eventId: string) {
  const { accountId } = useApp();
  const qc = useQueryClient();
  return (r?: RuleChangeResult) => {
    const run = () => {
      void qc.invalidateQueries({ queryKey: ["rules", accountId, eventId] });
      void qc.invalidateQueries({ queryKey: ["occurrences", accountId, eventId] });
      void qc.invalidateQueries({ queryKey: ["prices", accountId, eventId] });
      void qc.invalidateQueries({ queryKey: ["audit", accountId] });
    };
    run();
    if (r?.resolution === "queued") for (const ms of [3000, 8000]) setTimeout(run, ms);
  };
}

/**
 * An event's occurrence rules: conditions on the local start time, effects on location,
 * tags and ticket link. Per field, an override wins, then the highest-priority rule, then
 * the event default.
 */
export function Rules({ event }: { event: CatalogEvent }) {
  const { t, i18n } = useTranslation();
  const { api } = useApp();
  const rulesQuery = useEventRules(event.id);
  const rules = rulesQuery.data ?? [];
  const path = locationPath(useLocations(true).data);
  const tagLabels = useTagLabels(useVocabularies().data);
  const [editor, setEditor] = useState<RuleEditorMode | null>(null);
  const [toDelete, setToDelete] = useState<Rule | null>(null);
  const [conflict, setConflict] = useState(false);
  const refresh = useRuleRefresh(event.id);
  const archived = event.status === "archived";
  const onError = (e: Error) => isConflict(e) && setConflict(true);

  const toggle = useMutation({
    mutationFn: async (r: Rule) =>
      unwrap(await api.PATCH("/v1/rules/{id}", { params: { path: { id: r.id }, query: { dryRun: false } }, body: { active: !r.active }, headers: { "If-Match": etagOf(r.version) } })),
    onSuccess: (r) => {
      toast.success(t(r.resolution === "queued" ? "rules.savedQueued" : "rules.saved", { count: r.preview.counts.changed }));
      refresh(r);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: async (r: Rule) => unwrap(await api.DELETE("/v1/rules/{id}", { params: { path: { id: r.id }, query: { dryRun: false } }, headers: { "If-Match": etagOf(r.version) } })),
    onSuccess: (r) => {
      setToDelete(null);
      toast.success(t("rules.deleted", { count: r.preview.counts.changed }));
      refresh(r);
    },
    onError,
  });
  const error = [toggle.error, remove.error].find((e) => e && !isConflict(e));
  const offers = useEventOffers(event.id, event.admissionMode === "tickets").data ?? [];
  const names = {
    location: (id: string) => path(id) || "…", tag: (id: string) => tagLabels.get(id)?.text ?? "…",
    offer: (id: string) => offerName(offers.find((o) => o.id === id), i18n.language), money: (minor: number) => formatMoney(minor, i18n.language),
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-prose text-sm text-muted-foreground">{t("rules.intro")}</p>
        <Button onClick={() => setEditor({ kind: "create" })} disabled={archived}>
          <Plus /> {t("rules.add")}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      {rulesQuery.isLoading ? null : rules.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{t("rules.empty")}</p>
      ) : (
        <ol className="grid gap-2">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={r.active ? "font-medium" : "font-medium text-muted-foreground line-through"}>{r.name}</span>
                  <Badge variant="outline" className="font-normal">{t("rules.priorityBadge", { priority: r.priority })}</Badge>
                  {!r.active && <Badge variant="secondary">{t("rules.inactive")}</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">{describeConditions(r.conditions, t, i18n.language)}</p>
                <p className="text-sm">{describeEffects(r.effects, t, names)}</p>
              </div>
              <div className="flex items-center gap-1">
                <Switch
                  checked={r.active}
                  disabled={archived || toggle.isPending}
                  aria-label={`${t("rules.active")}: ${r.name}`}
                  onCheckedChange={() => toggle.mutate(r)}
                />
                <Button variant="ghost" size="icon" aria-label={`${t("common.edit")} ${r.name}`} disabled={archived} onClick={() => setEditor({ kind: "edit", rule: r })}>
                  <Pencil />
                </Button>
                <Button variant="ghost" size="icon" aria-label={`${t("common.delete")} ${r.name}`} disabled={archived} onClick={() => setToDelete(r)}>
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <RuleEditor
        event={event}
        rules={rules}
        mode={editor}
        onClose={() => setEditor(null)}
        onSaved={(r) => {
          setEditor(null);
          refresh(r);
        }}
        onConflict={() => {
          setEditor(null);
          setConflict(true);
        }}
      />
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("rules.deleteTitle", { name: toDelete?.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("rules.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("conflict.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => toDelete && remove.mutate(toDelete)}>{t("common.delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => refresh()} />
    </div>
  );
}
