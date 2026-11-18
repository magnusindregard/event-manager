import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Field } from "@/components/page";
import { formatInZone } from "@/components/zoned-datetime";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { type CatalogEvent, etagOf, isConflict, type Series, type SeriesChangeResult, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";
import {
  buildRule, followingRule, type Freq, parseRule, type RuleForm, splitLocal, splitRrule, WEEKDAYS, weekdayNames, weekdayOf,
} from "../../lib/recurrence.js";

/** Create a series, edit the entire series, or edit this and following (split at a slot). */
export type EditorMode =
  | { kind: "create" }
  | { kind: "edit"; series: Series }
  /** slotsBefore: slots of the series before `at` (lib/recurrence slotsBefore), used up by a COUNT. */
  | { kind: "split"; series: Series; at: string; slotsBefore: number };

type Draft = { rule: RuleForm; date: string; time: string; durationMin: number };

function initial(mode: EditorMode, event: CatalogEvent): Draft {
  if (mode.kind === "create") {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    return {
      rule: { ...parseRule("FREQ=WEEKLY"), byday: [weekdayOf(tomorrow)] },
      date: tomorrow,
      time: "12:00",
      durationMin: event.defaultDurationMin,
    };
  }
  const { date, time } = splitLocal(mode.kind === "split" ? mode.at : mode.series.dtstartLocal);
  const rule = mode.kind === "split" ? followingRule(mode.series.rrule, mode.slotsBefore) : parseRule(mode.series.rrule);
  return { rule, date, time, durationMin: mode.series.durationMin };
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function RecurrenceEditor({ event, mode, onClose, onSaved, onConflict }: {
  event: CatalogEvent;
  mode: EditorMode | null;
  onClose(): void;
  onSaved(): void;
  onConflict(): void;
}) {
  return (
    <Sheet open={!!mode} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-lg">
        {mode && <EditorBody key={JSON.stringify(mode.kind === "create" ? mode : [mode.kind, mode.series.id, mode.series.version])} event={event} mode={mode} onSaved={onSaved} onConflict={onConflict} />}
      </SheetContent>
    </Sheet>
  );
}

function EditorBody({ event, mode, onSaved, onConflict }: { event: CatalogEvent; mode: EditorMode; onSaved(): void; onConflict(): void }) {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const [start] = useState<Draft>(() => initial(mode, event));
  const [d, setD] = useState<Draft>(start);
  const names = weekdayNames(i18n.language);
  const timezone = mode.kind === "create" ? event.timezone : mode.series.timezone;
  const setRule = (patch: Partial<RuleForm>) => setD({ ...d, rule: { ...d.rule, ...patch } });

  const body = useMemo(
    () => ({ rrule: buildRule(d.rule), dtstartLocal: `${d.date}T${d.time}`, durationMin: d.durationMin }),
    [d],
  );
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(d.date) && /^\d{2}:\d{2}$/.test(d.time) && d.durationMin >= 1 &&
    (d.rule.mode === "custom" ? d.rule.custom.trim().length > 5 : (d.rule.freq !== "WEEKLY" || d.rule.byday.length > 0) && d.rule.interval >= 1 &&
      (d.rule.end !== "until" || d.rule.untilDate >= d.date) && (d.rule.end !== "count" || d.rule.count >= 1));

  const send = async (dryRun: boolean): Promise<SeriesChangeResult> => {
    if (mode.kind === "create") {
      return unwrap(await api.POST("/v1/events/{id}/series", {
        params: { path: { id: event.id }, query: { dryRun } }, body,
        headers: dryRun ? {} : { "Idempotency-Key": crypto.randomUUID() },
      }));
    }
    const headers = { "If-Match": etagOf(mode.series.version) };
    if (mode.kind === "edit") {
      return unwrap(await api.PATCH("/v1/series/{id}", { params: { path: { id: mode.series.id }, query: { dryRun } }, body, headers }));
    }
    // Unchanged rule: leave it out, so the new series keeps the remaining COUNT (or UNTIL) the server works out.
    const { rrule: _, ...rest } = body;
    const rrule = splitRrule(d.rule, start.rule);
    return unwrap(await api.POST("/v1/series/{id}/split", {
      params: { path: { id: mode.series.id }, query: { dryRun } }, body: { ...rest, ...(rrule ? { rrule } : {}), at: mode.at }, headers,
    }));
  };

  const debounced = useDebounced(body, 400);
  const preview = useQuery({
    queryKey: ["series-preview", accountId, event.id, mode.kind, mode.kind === "create" ? null : mode.series.version, debounced],
    queryFn: () => send(true),
    enabled: valid,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => send(false),
    onSuccess: (r) => {
      const c = r.changes.counts;
      toast.success(t("series.savedSummary", { created: c.created, moved: c.moved, deleted: c.deleted, conflicts: c.conflicts }));
      onSaved();
    },
    onError: (e) => isConflict(e) && onConflict(),
  });

  const fmt = (iso: string) => formatInZone(iso, timezone, i18n.language);
  const changes = preview.data?.changes;
  const title = t(`series.editor.title.${mode.kind}`);

  return (
    <form
      className="flex h-full flex-col overflow-y-auto"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <SheetHeader>
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>
          {mode.kind === "split" ? t("series.editor.splitHint", { tz: timezone }) : t("occurrences.timesIn", { tz: timezone })}
        </SheetDescription>
      </SheetHeader>

      <div className="grid gap-4 px-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={mode.kind === "split" ? t("series.editor.fromDate") : t("series.editor.startDate")} htmlFor="rec-date">
            <Input id="rec-date" type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} required />
          </Field>
          <Field label={t("series.editor.time")} htmlFor="rec-time">
            <Input id="rec-time" type="time" value={d.time} onChange={(e) => setD({ ...d, time: e.target.value })} required />
          </Field>
        </div>
        <Field label={t("series.editor.duration")} htmlFor="rec-duration">
          <Input id="rec-duration" type="number" min={1} max={100000} className="w-32" value={d.durationMin} onChange={(e) => setD({ ...d, durationMin: Number(e.target.value) })} />
        </Field>

        <Field label={t("series.editor.repeat")} htmlFor="rec-freq">
          <Select
            value={d.rule.mode === "custom" ? "CUSTOM" : d.rule.freq}
            onValueChange={(v) => (v === "CUSTOM" ? setRule({ mode: "custom", custom: buildRule(d.rule) }) : setRule({ mode: "simple", freq: v as Freq }))}
          >
            <SelectTrigger id="rec-freq" className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(["DAILY", "WEEKLY", "MONTHLY", "YEARLY", "CUSTOM"] as const).map((f) => (
                <SelectItem key={f} value={f}>{t(`series.editor.freq.${f}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {d.rule.mode === "custom" ? (
          <Field label={t("series.editor.custom")} htmlFor="rec-custom" hint={t("series.editor.customHint")}>
            <Textarea id="rec-custom" className="font-mono text-xs" value={d.rule.custom} onChange={(e) => setRule({ custom: e.target.value })} />
          </Field>
        ) : (
          <>
            <Field label={t("series.editor.interval")} htmlFor="rec-interval">
              <div className="flex items-center gap-2">
                <Input id="rec-interval" type="number" min={1} max={1000} className="w-20" value={d.rule.interval} onChange={(e) => setRule({ interval: Number(e.target.value) })} />
                <span className="text-sm text-muted-foreground">{t(`series.editor.unit.${d.rule.freq}`, { count: d.rule.interval })}</span>
              </div>
            </Field>
            {d.rule.freq === "WEEKLY" && (
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">{t("series.editor.weekdays")}</legend>
                <div className="flex flex-wrap gap-1">
                  {WEEKDAYS.map((w) => {
                    const on = d.rule.byday.includes(w);
                    return (
                      <Button
                        key={w}
                        type="button"
                        size="sm"
                        variant={on ? "default" : "outline"}
                        aria-pressed={on}
                        className="w-12"
                        onClick={() => setRule({ byday: on ? d.rule.byday.filter((x) => x !== w) : [...d.rule.byday, w] })}
                      >
                        {names[w]}
                      </Button>
                    );
                  })}
                </div>
              </fieldset>
            )}
            <Field label={t("series.editor.ends")} htmlFor="rec-end">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={d.rule.end} onValueChange={(v) => setRule({ end: v as RuleForm["end"], untilDate: d.rule.untilDate || d.date })}>
                  <SelectTrigger id="rec-end" className="w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(["never", "until", "count"] as const).map((e) => <SelectItem key={e} value={e}>{t(`series.editor.end.${e}`)}</SelectItem>)}
                  </SelectContent>
                </Select>
                {d.rule.end === "until" && (
                  <Input type="date" aria-label={t("series.editor.end.until")} className="w-44" min={d.date} value={d.rule.untilDate} onChange={(e) => setRule({ untilDate: e.target.value })} />
                )}
                {d.rule.end === "count" && (
                  <div className="flex items-center gap-2">
                    <Input type="number" aria-label={t("series.editor.end.count")} min={1} max={10000} className="w-24" value={d.rule.count} onChange={(e) => setRule({ count: Number(e.target.value) })} />
                    <span className="text-sm text-muted-foreground">{t("series.editor.occurrences", { count: d.rule.count })}</span>
                  </div>
                )}
              </div>
            </Field>
            {d.rule.end === "never" && <p className="-mt-2 text-xs text-muted-foreground">{t("series.editor.horizonHint")}</p>}
          </>
        )}

        <section aria-live="polite" className="grid gap-2 rounded-md border p-3">
          <h3 className="text-sm font-medium">{t("series.preview.title")}</h3>
          {!valid ? (
            <p className="text-sm text-muted-foreground">{t("series.preview.incomplete")}</p>
          ) : preview.error ? (
            <p className="text-sm text-destructive">{preview.error.message}</p>
          ) : !changes ? (
            <p className="text-sm text-muted-foreground">{t("series.preview.loading")}</p>
          ) : (
            <>
              <p className="text-sm">{t("series.preview.counts", changes.counts)}</p>
              {changes.created.length > 0 && (
                <PreviewList title={t("series.preview.new")} items={changes.created.map((c) => fmt(c.startUtc))} total={changes.counts.created} />
              )}
              {changes.moved.length > 0 && (
                <PreviewList title={t("series.preview.moved")} items={changes.moved.map((m) => `${fmt(m.fromStartUtc)} → ${fmt(m.startUtc)}`)} total={changes.counts.moved} />
              )}
              {changes.deleted.length > 0 && (
                <PreviewList title={t("series.preview.deleted")} items={changes.deleted.map((c) => fmt(c.startUtc))} total={changes.counts.deleted} />
              )}
              {changes.conflicts.length > 0 && (
                <Alert>
                  <TriangleAlert />
                  <AlertDescription>
                    <p>{t("series.preview.conflicts", { count: changes.counts.conflicts })}</p>
                    <ul className="mt-1 list-disc pl-4">
                      {changes.conflicts.slice(0, 8).map((c) => <li key={c.occurrenceId}>{fmt(c.startUtc)} – {t(`series.conflictReason.${c.reason}`)}</li>)}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
        </section>

        {save.error && !isConflict(save.error) && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{save.error.message}</AlertDescription>
          </Alert>
        )}
      </div>
      <SheetFooter>
        <Button type="submit" disabled={!valid || save.isPending || !!preview.error}>{t(`series.editor.save.${mode.kind}`)}</Button>
      </SheetFooter>
    </form>
  );
}

function PreviewList({ title, items, total }: { title: string; items: string[]; total: number }) {
  const { t } = useTranslation();
  const shown = items.slice(0, 6);
  return (
    <div className="text-sm">
      <p className="text-muted-foreground">{title}</p>
      <ul className="list-disc pl-5">
        {shown.map((s, i) => <li key={i}>{s}</li>)}
      </ul>
      {total > shown.length && <p className="text-xs text-muted-foreground">{t("series.preview.more", { count: total - shown.length })}</p>}
    </div>
  );
}
