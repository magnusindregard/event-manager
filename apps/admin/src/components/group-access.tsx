import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useUserGroups } from "../queries.js";

/**
 * Who may attend an event or buy a ticket type (docs/user-groups.md): everyone, or only the
 * checked user groups. Archived groups show only while they are still on the list.
 */
export function GroupAccessField({ id, legend, everyone, hint, value, onChange, disabled }: {
  id: string;
  legend: string;
  everyone: string;
  hint?: string;
  value: string[];
  onChange(ids: string[]): void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const groups = (useUserGroups().data ?? []).filter((g) => !g.archived || value.includes(g.id));
  if (groups.length === 0 && value.length === 0) return null;
  const name = (g: (typeof groups)[number]) => g.names[i18n.language] ?? Object.values(g.names)[0] ?? g.code;
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="flex items-center gap-2">
        <Checkbox id={`${id}-everyone`} checked={value.length === 0} onCheckedChange={(on) => on && onChange([])} />
        <Label htmlFor={`${id}-everyone`} className="font-normal">{everyone}</Label>
      </div>
      {groups.map((g) => (
        <div key={g.id} className="flex items-center gap-2">
          <Checkbox id={`${id}-${g.id}`} checked={value.includes(g.id)}
            onCheckedChange={(on) => onChange(on ? [...value, g.id] : value.filter((x) => x !== g.id))} />
          <Label htmlFor={`${id}-${g.id}`} className="font-normal">
            {name(g)} {g.archived && <span className="text-muted-foreground">({t("groups.archived")})</span>}
          </Label>
        </div>
      ))}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </fieldset>
  );
}
