import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LocationSelect, TagPicker } from "@/components/catalog-fields";
import { Field } from "@/components/page";
import { formatInZone } from "@/components/zoned-datetime";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { type CatalogEvent, etagOf, isConflict, type Rule, type RuleChangeResult, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { type Conditions, type Effect, ISO_WEEKDAYS, isoWeekdayNames, NO_CONDITIONS } from "../../lib/rules.js";
import { formatMoney, moneyInput, parseMoney } from "../../lib/money.js";
import { locationPath, offerName, useEventOffers, useLocations, useTagLabels, useVocabularies, useUserGroups } from "../../queries.js";

/** Create a rule (optionally from the occurrence filter), or edit one. */
export type RuleEditorMode = { kind: "create"; conditions?: Conditions } | { kind: "edit"; rule: Rule };

type Draft = {
  name: string;
  priority: number;
  active: boolean;
  conditions: Conditions;
  location: { on: boolean; id: string | null };
  tags: { on: boolean; add: string[]; remove: string[] };
  link: { on: boolean; url: string };
  capacity: { on: boolean; value: string };
  overbooking: { on: boolean; value: string };
  /** Per offer: a price (in kroner, as typed) and availability, and prices per user group (docs/user-groups.md). */
  offers: Record<string, OfferDraft>;
};
type OfferDraft = { price: { on: boolean; value: string }; available: { on: boolean; value: boolean }; groups: Record<string, { on: boolean; value: string }> };
const emptyOffer = (): OfferDraft => ({ price: { on: false, value: "" }, available: { on: false, value: false }, groups: {} });

const wholeIn = (v: string, max: number) => /^\d+$/.test(v.trim()) && Number(v) <= max;

function initial(mode: RuleEditorMode, language: string): Draft {
  const effects = mode.kind === "edit" ? mode.rule.effects : [];
  const find = <T extends Effect["type"]>(type: T) => effects.find((e) => e.type === type) as Extract<Rule["effects"][number], { type: T }> | undefined;
  const loc = find("location");
  const tags = find("tags");
  const link = find("externalUrl");
  const capacity = find("capacity");
  const overbooking = find("overbooking");
  return {
    name: mode.kind === "edit" ? mode.rule.name : "",
    priority: mode.kind === "edit" ? mode.rule.priority : 0,
    active: mode.kind === "edit" ? mode.rule.active : true,
    conditions: mode.kind === "edit" ? mode.rule.conditions : (mode.conditions ?? NO_CONDITIONS),
    location: { on: !!loc, id: loc?.value ?? null },
    tags: { on: !!tags, add: tags?.value.add ?? [], remove: tags?.value.remove ?? [] },
    link: { on: !!link, url: link?.value ?? "" },
    capacity: { on: !!capacity, value: capacity ? String(capacity.value) : "" },
    overbooking: { on: !!overbooking, value: overbooking ? String(overbooking.value) : "" },
    offers: effects.reduce<Draft["offers"]>((out, e) => {
      if (e.type !== "price" && e.type !== "offerAvailable") return out;
      const o = out[e.targetRef] ?? emptyOffer();
      if (e.type === "price" && e.targetGroup) o.groups = { ...o.groups, [e.targetGroup]: { on: true, value: moneyInput(e.value.amount, language) } };
      else if (e.type === "price") o.price = { on: true, value: moneyInput(e.value.amount, language) };
      else o.available = { on: true, value: e.value };
      return { ...out, [e.targetRef]: o };
    }, {}),
  };
}

function effectsOf(d: Draft): Effect[] {
  const out: Effect[] = [];
  if (d.location.on && d.location.id) out.push({ type: "location", value: d.location.id });
  if (d.tags.on && d.tags.add.length + d.tags.remove.length > 0) out.push({ type: "tags", value: { add: d.tags.add, remove: d.tags.remove } });
  if (d.link.on && /^https?:\/\/\S+$/.test(d.link.url.trim())) out.push({ type: "externalUrl", value: d.link.url.trim() });
  if (d.capacity.on && wholeIn(d.capacity.value, 1_000_000)) out.push({ type: "capacity", value: Number(d.capacity.value) });
  if (d.overbooking.on && wholeIn(d.overbooking.value, 100)) out.push({ type: "overbooking", value: Number(d.overbooking.value) });
  for (const [targetRef, o] of Object.entries(d.offers)) {
    const amount = parseMoney(o.price.value);
    if (o.price.on && amount !== null) out.push({ type: "price", targetRef, value: { amount } });
    if (o.available.on) out.push({ type: "offerAvailable", targetRef, value: o.available.value });
    for (const [targetGroup, g] of Object.entries(o.groups)) {
      const groupAmount = parseMoney(g.value);
      if (g.on && groupAmount !== null) out.push({ type: "price", targetRef, targetGroup, value: { amount: groupAmount } });
    }
  }
  return out;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function RuleEditor({ event, rules, mode, onClose, onSaved, onConflict }: {
  event: CatalogEvent;
  rules: Rule[];
  mode: RuleEditorMode | null;
  onClose(): void;
  onSaved(result: RuleChangeResult): void;
  onConflict(): void;
}) {
  return (
    <Sheet open={!!mode} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-lg">
        {mode && (
          <EditorBody
            key={mode.kind === "edit" ? `${mode.rule.id}:${mode.rule.version}` : JSON.stringify(mode)}
            event={event}
            rules={rules}
            mode={mode}
            onSaved={onSaved}
            onConflict={onConflict}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function EditorBody({ event, rules, mode, onSaved, onConflict }: {
  event: CatalogEvent;
  rules: Rule[];
  mode: RuleEditorMode;
  onSaved(result: RuleChangeResult): void;
  onConflict(): void;
}) {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const [d, setD] = useState<Draft>(() => initial(mode, i18n.language));
  const ticketed = event.admissionMode === "tickets";
  const allOffers = useEventOffers(event.id, ticketed).data ?? [];
  // Archived offers stay editable on rules that already have them.
  const offers = allOffers.filter((o) => o.status === "active" || o.id in d.offers);
  const offerDraft = (id: string) => d.offers[id] ?? emptyOffer();
  const allGroups = useUserGroups().data ?? [];
  // Archived groups stay editable on rules that already price them.
  const groupsFor = (od: OfferDraft) => allGroups.filter((g) => !g.archived || g.id in od.groups);
  const groupName = (id: string | null) => {
    const g = allGroups.find((x) => x.id === id);
    return g ? (g.names[i18n.language] ?? Object.values(g.names)[0] ?? g.code) : "";
  };
  const setOffer = (id: string, patch: Partial<Draft["offers"][string]>) => setD({ ...d, offers: { ...d.offers, [id]: { ...offerDraft(id), ...patch } } });
  const names = isoWeekdayNames(i18n.language);
  const path = locationPath(useLocations(true).data);
  const tagLabels = useTagLabels(useVocabularies().data);
  const ruleName = (id: string | null) => (id ? (rules.find((r) => r.id === id)?.name ?? (d.name || t("rules.thisRule"))) : "");
  const setCond = (patch: Partial<Conditions>) => setD({ ...d, conditions: { ...d.conditions, ...patch } });

  const body = useMemo(() => ({ name: d.name.trim(), priority: d.priority, active: d.active, conditions: d.conditions, effects: effectsOf(d) }), [d]);
  const c = d.conditions;
  const valid =
    body.name.length > 0 && body.effects.length > 0 && Number.isInteger(d.priority) && d.priority >= -1000 && d.priority <= 1000 &&
    (!c.dateFrom || !c.dateTo || c.dateFrom <= c.dateTo) && (!c.startTimeFrom || c.startTimeFrom !== c.startTimeTo) &&
    Object.values(d.offers).every((o) => (!o.price.on || parseMoney(o.price.value) !== null) && Object.values(o.groups).every((g) => !g.on || parseMoney(g.value) !== null));

  const send = async (dryRun: boolean) => {
    if (mode.kind === "create") {
      return unwrap(await api.POST("/v1/events/{id}/rules", {
        params: { path: { id: event.id }, query: { dryRun } }, body,
        headers: dryRun ? {} : { "Idempotency-Key": crypto.randomUUID() },
      }));
    }
    return unwrap(await api.PATCH("/v1/rules/{id}", {
      params: { path: { id: mode.rule.id }, query: { dryRun } }, body, headers: { "If-Match": etagOf(mode.rule.version) },
    }));
  };

  const debounced = useDebounced(body, 400);
  const preview = useQuery({
    queryKey: ["rule-preview", accountId, event.id, mode.kind === "edit" ? [mode.rule.id, mode.rule.version] : null, debounced],
    queryFn: () => send(true),
    enabled: valid,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => send(false),
    onSuccess: (r) => {
      toast.success(r.resolution === "queued" ? t("rules.savedQueued", { count: r.preview.counts.changed }) : t("rules.saved", { count: r.preview.counts.changed }));
      onSaved(r);
    },
    onError: (e) => isConflict(e) && onConflict(),
  });

  const fmt = (iso: string) => formatInZone(iso, event.timezone, i18n.language);
  const show = (field: string, v: { value: unknown; source: string; ruleId: string | null }) => {
    const value =
      field === "price" ? formatMoney(v.value as number, i18n.language)
      : field === "offerAvailable" ? (v.value ? t("prices.onSale") : t("prices.offSale"))
      : field === "location" ? (v.value ? path(v.value as string) : "—")
      : field === "tags" ? ((v.value as string[]).map((x) => tagLabels.get(x)?.text ?? "…").join(", ") || "—")
      : ((v.value as string | null)?.replace(/^https?:\/\//, "") ?? "—");
    return v.source === "rule" ? `${value} (${ruleName(v.ruleId)})` : value;
  };
  const p = preview.data?.preview;

  return (
    <form
      className="flex h-full flex-col overflow-y-auto"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <SheetHeader>
        <SheetTitle>{mode.kind === "edit" ? t("rules.edit") : t("rules.add")}</SheetTitle>
        <SheetDescription>{t("rules.editorHint", { tz: event.timezone })}</SheetDescription>
      </SheetHeader>

      <div className="grid gap-4 px-4">
        <Field label={t("rules.name")} htmlFor="rule-name">
          <Input id="rule-name" value={d.name} maxLength={200} onChange={(e) => setD({ ...d, name: e.target.value })} required placeholder={t("rules.namePlaceholder")} />
        </Field>
        <div className="flex flex-wrap items-end gap-6">
          <Field label={t("rules.priority")} htmlFor="rule-priority" hint={t("rules.priorityHint")} className="max-w-56">
            <Input id="rule-priority" type="number" min={-1000} max={1000} className="w-24" value={d.priority} onChange={(e) => setD({ ...d, priority: Number(e.target.value) })} />
          </Field>
          <div className="flex items-center gap-2 pb-7">
            <Switch id="rule-active" checked={d.active} onCheckedChange={(v) => setD({ ...d, active: v })} />
            <Label htmlFor="rule-active">{t("rules.active")}</Label>
          </div>
        </div>

        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm font-medium">{t("rules.when")}</legend>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("rules.dateFrom")} htmlFor="rule-date-from">
              <Input id="rule-date-from" type="date" value={c.dateFrom ?? ""} onChange={(e) => setCond({ dateFrom: e.target.value || null })} />
            </Field>
            <Field label={t("rules.dateTo")} htmlFor="rule-date-to">
              <Input id="rule-date-to" type="date" min={c.dateFrom ?? undefined} value={c.dateTo ?? ""} onChange={(e) => setCond({ dateTo: e.target.value || null })} />
            </Field>
          </div>
          <div className="grid gap-2">
            <span className="text-sm" id="rule-weekdays">{t("rules.weekdays")}</span>
            <div className="flex flex-wrap gap-1" role="group" aria-labelledby="rule-weekdays">
              {ISO_WEEKDAYS.map((w) => {
                const on = c.weekdays?.includes(w) ?? false;
                return (
                  <Button
                    key={w}
                    type="button"
                    size="sm"
                    variant={on ? "default" : "outline"}
                    aria-pressed={on}
                    className="w-12"
                    onClick={() => {
                      const next = on ? (c.weekdays ?? []).filter((x) => x !== w) : [...(c.weekdays ?? []), w].sort();
                      setCond({ weekdays: next.length ? next : null });
                    }}
                  >
                    {names[w]}
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">{t("rules.weekdaysHint")}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("rules.timeFrom")} htmlFor="rule-time-from">
              <Input id="rule-time-from" type="time" value={c.startTimeFrom ?? ""} onChange={(e) => setCond({ startTimeFrom: e.target.value || null })} />
            </Field>
            <Field label={t("rules.timeTo")} htmlFor="rule-time-to">
              <Input id="rule-time-to" type="time" value={c.startTimeTo ?? ""} onChange={(e) => setCond({ startTimeTo: e.target.value || null })} />
            </Field>
          </div>
          <p className="-mt-1 text-xs text-muted-foreground">{t("rules.timeToHint")}</p>
        </fieldset>

        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm font-medium">{t("rules.then")}</legend>
          <div className="flex items-center gap-2">
            <Checkbox id="rule-eff-location" checked={d.location.on} onCheckedChange={(v) => setD({ ...d, location: { ...d.location, on: v === true } })} />
            <Label htmlFor="rule-eff-location">{t("rules.setLocation")}</Label>
          </div>
          {d.location.on && (
            <LocationSelect id="rule-location" value={d.location.id} onChange={(id) => setD({ ...d, location: { on: true, id } })} noneLabel={t("rules.chooseLocation")} />
          )}
          <div className="flex items-center gap-2">
            <Checkbox id="rule-eff-tags" checked={d.tags.on} onCheckedChange={(v) => setD({ ...d, tags: { ...d.tags, on: v === true } })} />
            <Label htmlFor="rule-eff-tags">{t("rules.changeTags")}</Label>
          </div>
          {d.tags.on && (
            <div className="grid gap-3 pl-6">
              <Field label={t("rules.addTags")} htmlFor="rule-tags-add">
                <TagPicker id="rule-tags-add" value={d.tags.add} onChange={(add) => setD({ ...d, tags: { ...d.tags, add, remove: d.tags.remove.filter((x) => !add.includes(x)) } })} />
              </Field>
              <Field label={t("rules.removeTags")} htmlFor="rule-tags-remove">
                <TagPicker id="rule-tags-remove" value={d.tags.remove} onChange={(remove) => setD({ ...d, tags: { ...d.tags, remove, add: d.tags.add.filter((x) => !remove.includes(x)) } })} />
              </Field>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox id="rule-eff-link" checked={d.link.on} onCheckedChange={(v) => setD({ ...d, link: { ...d.link, on: v === true } })} />
            <Label htmlFor="rule-eff-link">{t("rules.setLink")}</Label>
          </div>
          {d.link.on && (
            <Input id="rule-link" type="url" aria-label={t("occurrences.link")} placeholder="https://" value={d.link.url} onChange={(e) => setD({ ...d, link: { on: true, url: e.target.value } })} />
          )}
          {(["capacity", "overbooking"] as const).map((k) => (
            <div key={k} className="grid gap-2">
              <div className="flex items-center gap-2">
                <Checkbox id={`rule-eff-${k}`} checked={d[k].on} onCheckedChange={(v) => setD({ ...d, [k]: { ...d[k], on: v === true } })} />
                <Label htmlFor={`rule-eff-${k}`}>{t(`rules.set_${k}`)}</Label>
              </div>
              {d[k].on && (
                <Input id={`rule-${k}`} type="number" min={0} max={k === "capacity" ? 1000000 : 100} aria-label={t(`rules.effect.${k}`)} className="w-40"
                  value={d[k].value} onChange={(e) => setD({ ...d, [k]: { on: true, value: e.target.value } })} />
              )}
            </div>
          ))}
        </fieldset>

        {ticketed && offers.length > 0 && (
          <fieldset className="grid gap-3">
            <legend className="mb-1 text-sm font-medium">{t("rules.offers")}</legend>
            {offers.map((o) => {
              const od = offerDraft(o.id);
              const name = offerName(o, i18n.language);
              const bad = od.price.on && parseMoney(od.price.value) === null;
              return (
                <div key={o.id} className="grid gap-2 rounded-md border p-3">
                  <span className="text-sm font-medium">{name} <span className="font-normal text-muted-foreground">· {formatMoney(o.defaultPrice, i18n.language)}</span></span>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Checkbox id={`rule-price-${o.id}`} checked={od.price.on} onCheckedChange={(v) => setOffer(o.id, { price: { ...od.price, on: v === true } })} />
                      <Label htmlFor={`rule-price-${o.id}`}>{t("rules.setPrice")}</Label>
                    </div>
                    {od.price.on && (
                      <Input id={`rule-price-value-${o.id}`} inputMode="decimal" className="w-32" aria-label={`${t("rules.setPrice")}: ${name}`} aria-invalid={bad}
                        value={od.price.value} placeholder={moneyInput(o.defaultPrice, i18n.language)} onChange={(e) => setOffer(o.id, { price: { on: true, value: e.target.value } })} />
                    )}
                  </div>
                  {groupsFor(od).map((g) => {
                    const gd = od.groups[g.id] ?? { on: false, value: "" };
                    const gName = groupName(g.id);
                    const setGroup = (v: { on: boolean; value: string }) => setOffer(o.id, { groups: { ...od.groups, [g.id]: v } });
                    return (
                      <div key={g.id} className="flex flex-wrap items-center gap-3">
                        <div className="flex items-center gap-2">
                          <Checkbox id={`rule-group-${o.id}-${g.id}`} checked={gd.on} onCheckedChange={(v) => setGroup({ ...gd, on: v === true })} />
                          <Label htmlFor={`rule-group-${o.id}-${g.id}`}>{t("rules.setGroupPrice", { group: gName })}</Label>
                        </div>
                        {gd.on && (
                          <Input inputMode="decimal" className="w-32" aria-label={`${t("rules.setGroupPrice", { group: gName })}: ${name}`} aria-invalid={parseMoney(gd.value) === null}
                            value={gd.value} onChange={(e) => setGroup({ on: true, value: e.target.value })} />
                        )}
                      </div>
                    );
                  })}
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Checkbox id={`rule-avail-${o.id}`} checked={od.available.on} onCheckedChange={(v) => setOffer(o.id, { available: { ...od.available, on: v === true } })} />
                      <Label htmlFor={`rule-avail-${o.id}`}>{t("rules.setAvailable")}</Label>
                    </div>
                    {od.available.on && (
                      <div className="flex items-center gap-2">
                        <Switch id={`rule-avail-value-${o.id}`} checked={od.available.value} onCheckedChange={(v) => setOffer(o.id, { available: { on: true, value: v } })} />
                        <Label htmlFor={`rule-avail-value-${o.id}`}>{od.available.value ? t("prices.onSale") : t("prices.offSale")}</Label>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </fieldset>
        )}

        <section aria-live="polite" className="grid gap-2 rounded-md border p-3">
          <h3 className="text-sm font-medium">{t("series.preview.title")}</h3>
          {!valid ? (
            <p className="text-sm text-muted-foreground">{t("rules.preview.incomplete")}</p>
          ) : preview.error ? (
            <p className="text-sm text-destructive">{preview.error.message}</p>
          ) : !p ? (
            <p className="text-sm text-muted-foreground">{t("series.preview.loading")}</p>
          ) : (
            <>
              <p className="text-sm">{t("rules.preview.counts", p.counts)}</p>
              {!d.active && <p className="text-xs text-muted-foreground">{t("rules.preview.inactive")}</p>}
              {p.changes.length > 0 && (
                <ul className="grid gap-1 text-sm">
                  {p.changes.slice(0, 6).map((ch) => (
                    <li key={ch.occurrenceId}>
                      <span className="font-medium">{fmt(ch.startUtc)}</span>
                      {ch.fields.map((f) => (
                        <span key={`${f.field}:${f.targetRef ?? ""}:${f.group ?? ""}`} className="block pl-3 text-muted-foreground">
                          {t(`rules.field.${f.field}`)}{f.targetRef && ` (${offerName(allOffers.find((o) => o.id === f.targetRef), i18n.language)}${f.group ? `, ${groupName(f.group)}` : ""})`}: {show(f.field, f.from)} → {show(f.field, f.to)}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
              {p.counts.changed > 6 && <p className="text-xs text-muted-foreground">{t("series.preview.more", { count: p.counts.changed - 6 })}</p>}
              {p.counts.conflicts > 0 && (
                <Alert className="border-amber-500">
                  <TriangleAlert />
                  <AlertDescription>
                    <p>{t("rules.preview.conflicts", { count: p.counts.conflicts })}</p>
                    <ul className="mt-1 list-disc pl-4">
                      {[...new Set(p.conflicts.flatMap((x) => x.ruleIds))].filter((id) => rules.some((r) => r.id === id) && (mode.kind === "create" || id !== mode.rule.id)).map((id) => (
                        <li key={id}>{ruleName(id)}</li>
                      ))}
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
        <Button type="submit" disabled={!valid || save.isPending || !!preview.error}>{mode.kind === "edit" ? t("common.save") : t("rules.create")}</Button>
      </SheetFooter>
    </form>
  );
}
