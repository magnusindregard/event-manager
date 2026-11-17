import { useTranslation } from "react-i18next";
import { Combobox } from "@/components/combobox";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { locationPath, useLocations, useTagLabels, useVocabularies } from "../queries.js";

const NONE = "__none";

/** Venue or space, grouped by venue. Archived locations are offered only if already selected. */
export function LocationSelect({ id, value, onChange, disabled, noneLabel }: {
  id: string;
  value: string | null;
  onChange(v: string | null): void;
  disabled?: boolean;
  noneLabel: string;
}) {
  const { t } = useTranslation();
  const { data = [] } = useLocations(true);
  const venues = data.filter((l) => l.kind === "venue" && (!l.archived || l.id === value || data.some((s) => s.parentId === l.id && s.id === value)));
  const path = locationPath(data);
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)} disabled={disabled}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue>{value ? path(value) : noneLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{noneLabel}</SelectItem>
        {venues.map((v) => (
          <SelectGroup key={v.id}>
            <SelectLabel>{v.name}</SelectLabel>
            <SelectItem value={v.id}>{v.name} <span className="text-muted-foreground">({t("locations.wholeVenue")})</span></SelectItem>
            {data
              .filter((s) => s.parentId === v.id && (!s.archived || s.id === value))
              .map((s) => (
                <SelectItem key={s.id} value={s.id} className="pl-6">{s.name}</SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

export function TagPicker({ id, value, onChange, disabled }: { id: string; value: string[]; onChange(v: string[]): void; disabled?: boolean }) {
  const { t } = useTranslation();
  const vocabs = useVocabularies();
  const labels = useTagLabels(vocabs.data);
  const options = [...labels.entries()].filter(([tagId, l]) => !l.tag.archived || value.includes(tagId)).map(([tagId]) => tagId);
  return (
    <Combobox
      id={id}
      multiple
      options={options}
      value={value}
      onChange={onChange}
      label={(tagId) => labels.get(tagId)?.text ?? tagId}
      disabled={disabled}
      placeholder={t("events.noTags")}
      searchPlaceholder={t("common.search")}
      emptyText={options.length ? t("common.noResults") : t("events.noVocabularies")}
    />
  );
}

/** "default / rule: X / override" chip next to a resolved value. */
/** cleared: an override with no value (the occurrence has no location / link). */
export function SourceChip({ source, rule, cleared }: { source: "default" | "rule" | "override" | undefined; rule?: string | undefined; cleared?: boolean }) {
  const { t } = useTranslation();
  if (!source) return null;
  return (
    <Badge
      variant={source === "override" ? "default" : "outline"}
      className={cn("max-w-48 truncate font-normal", source === "default" && "text-muted-foreground", source === "rule" && "border-sky-500 text-sky-700 dark:text-sky-400")}
      title={source === "rule" && rule ? rule : undefined}
    >
      {source === "rule" ? t("occurrences.source.ruleNamed", { name: rule ?? "…" }) : source === "override" && cleared ? t("occurrences.source.cleared") : t(`occurrences.source.${source}`)}
    </Badge>
  );
}
