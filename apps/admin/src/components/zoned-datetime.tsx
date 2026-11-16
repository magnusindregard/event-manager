import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { enGB, nb } from "date-fns/locale";
import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Date and time picked as wall-clock time in the event's timezone (not the browser's),
 * stored as a UTC ISO string. 14:00 in Europe/Oslo stays 14:00 whatever the editor's zone.
 */
export function ZonedDateTimeField({ id, label, timezone, value, onChange, disabled }: {
  id: string;
  /** Accessible name prefix, e.g. "Start"; the inputs become "Start, date" and "Start, time". */
  label: string;
  timezone: string;
  value: string | null;
  onChange(iso: string): void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const local = value ? new TZDate(value, timezone) : null;
  const locale = i18n.language === "nb" ? nb : enGB;

  const emit = (y: number, m: number, d: number, hh: number, mm: number) => onChange(new TZDate(y, m, d, hh, mm, timezone).toISOString());

  return (
    <div className="flex gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} variant="outline" className="w-44 justify-start font-normal" disabled={disabled} aria-label={`${label}, ${t("common.date")}: ${local ? format(local, "PPP", { locale }) : "—"}`}>
            <CalendarIcon />
            {local ? format(local, "PPP", { locale }) : "—"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            locale={locale}
            selected={local ? new Date(local.getFullYear(), local.getMonth(), local.getDate()) : undefined}
            defaultMonth={local ? new Date(local.getFullYear(), local.getMonth(), 1) : undefined}
            onSelect={(d) => {
              if (!d) return;
              emit(d.getFullYear(), d.getMonth(), d.getDate(), local?.getHours() ?? 12, local?.getMinutes() ?? 0);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <Input
        type="time"
        aria-label={`${label}, ${t("common.time")}`}
        className="w-28"
        disabled={disabled || !local}
        value={local ? format(local, "HH:mm") : ""}
        onChange={(e) => {
          const [hh, mm] = e.target.value.split(":").map(Number);
          if (local && hh !== undefined && mm !== undefined && !Number.isNaN(hh) && !Number.isNaN(mm)) {
            emit(local.getFullYear(), local.getMonth(), local.getDate(), hh, mm);
          }
        }}
      />
    </div>
  );
}

/** Formats a UTC instant in a timezone for display, e.g. "1 Dec 2026, 14:00". */
export function formatInZone(iso: string, timezone: string, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(iso));
}
