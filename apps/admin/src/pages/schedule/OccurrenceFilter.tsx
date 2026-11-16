import { FunnelX, ListFilter, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LocationSelect } from "@/components/catalog-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Location, Occurrence } from "../../api.js";
import { toLocal } from "../../lib/recurrence.js";
import { type Conditions, hasConditions, ISO_WEEKDAYS, isoWeekdayNames, matches, NO_CONDITIONS } from "../../lib/rules.js";

/**
 * Occurrence filter on the schedule (docs/mvp.md): the rule conditions (dates, weekdays,
 * start-time window in the event's timezone) plus effective location and status. The
 * conditions part can be saved as a rule, which then matches exactly these occurrences.
 */
export interface OccurrenceFilterValue {
  conditions: Conditions;
  locationId: string | null;
  status: "all" | "scheduled" | "cancelled";
}

export const EMPTY_FILTER: OccurrenceFilterValue = { conditions: NO_CONDITIONS, locationId: null, status: "all" };

export const isFiltering = (f: OccurrenceFilterValue) => hasConditions(f.conditions) || f.locationId !== null || f.status !== "all";

export function filterOccurrences(occs: Occurrence[], f: OccurrenceFilterValue, timezone: string, locations: Location[]): Occurrence[] {
  if (!isFiltering(f)) return occs;
  const parent = new Map(locations.map((l) => [l.id, l.parentId]));
  return occs.filter((o) => {
    if (f.status !== "all" && o.status !== f.status) return false;
    if (f.locationId) {
      const loc = o.effective.location?.value ?? null;
      if (loc !== f.locationId && (loc === null || parent.get(loc) !== f.locationId)) return false;
    }
    return matches(f.conditions, toLocal(o.startUtc, timezone));
  });
}

export function OccurrenceFilter({ value, onChange, onSaveAsRule, disabled }: {
  value: OccurrenceFilterValue;
  onChange(v: OccurrenceFilterValue): void;
  onSaveAsRule(conditions: Conditions): void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const names = isoWeekdayNames(i18n.language);
  const c = value.conditions;
  const setCond = (patch: Partial<Conditions>) => onChange({ ...value, conditions: { ...c, ...patch } });
  const onlyConditions = value.locationId === null && value.status === "all";

  return (
    <fieldset className="grid gap-3 rounded-md border p-3">
      <legend className="flex items-center gap-1.5 px-1 text-sm font-medium"><ListFilter className="size-4" /> {t("filter.title")}</legend>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs text-muted-foreground" htmlFor="filter-date-from">
          {t("rules.dateFrom")}
          <Input id="filter-date-from" type="date" className="w-40" value={c.dateFrom ?? ""} onChange={(e) => setCond({ dateFrom: e.target.value || null })} />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground" htmlFor="filter-date-to">
          {t("rules.dateTo")}
          <Input id="filter-date-to" type="date" className="w-40" min={c.dateFrom ?? undefined} value={c.dateTo ?? ""} onChange={(e) => setCond({ dateTo: e.target.value || null })} />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground" htmlFor="filter-time-from">
          {t("filter.startsFrom")}
          <Input id="filter-time-from" type="time" className="w-28" value={c.startTimeFrom ?? ""} onChange={(e) => setCond({ startTimeFrom: e.target.value || null })} />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground" htmlFor="filter-time-to">
          {t("filter.startsBefore")}
          <Input id="filter-time-to" type="time" className="w-28" value={c.startTimeTo ?? ""} onChange={(e) => setCond({ startTimeTo: e.target.value || null })} />
        </label>
        <div className="grid gap-1 text-xs text-muted-foreground">
          <span id="filter-weekdays">{t("rules.weekdays")}</span>
          <div className="flex gap-0.5" role="group" aria-labelledby="filter-weekdays">
            {ISO_WEEKDAYS.map((w) => {
              const on = c.weekdays?.includes(w) ?? false;
              return (
                <Button
                  key={w}
                  type="button"
                  size="sm"
                  variant={on ? "default" : "outline"}
                  aria-pressed={on}
                  className="h-9 w-10 px-0"
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
        </div>
        <div className="grid gap-1 text-xs text-muted-foreground">
          <label htmlFor="filter-location">{t("occurrences.location")}</label>
          <div className="w-56">
            <LocationSelect id="filter-location" value={value.locationId} onChange={(locationId) => onChange({ ...value, locationId })} noneLabel={t("events.allLocations")} />
          </div>
        </div>
        <label className="grid gap-1 text-xs text-muted-foreground" htmlFor="filter-status">
          {t("events.status")}
          <Select value={value.status} onValueChange={(status) => onChange({ ...value, status: status as OccurrenceFilterValue["status"] })}>
            <SelectTrigger id="filter-status" className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("events.allStatuses")}</SelectItem>
              <SelectItem value="scheduled">{t("filter.scheduled")}</SelectItem>
              <SelectItem value="cancelled">{t("occurrences.cancelled")}</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
      {isFiltering(value) && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(EMPTY_FILTER)}><FunnelX /> {t("filter.clear")}</Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || !hasConditions(c) || !onlyConditions}
            title={!onlyConditions ? t("filter.saveAsRuleHint") : undefined}
            onClick={() => onSaveAsRule(c)}
          >
            <WandSparkles /> {t("filter.saveAsRule")}
          </Button>
          {!onlyConditions && hasConditions(c) && <span className="text-xs text-muted-foreground">{t("filter.saveAsRuleHint")}</span>}
        </div>
      )}
    </fieldset>
  );
}
