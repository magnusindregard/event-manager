import type { EventClickArg, EventInput } from "@fullcalendar/core";
import enGbLocale from "@fullcalendar/core/locales/en-gb";
import nbLocale from "@fullcalendar/core/locales/nb";
import dayGridPlugin from "@fullcalendar/daygrid";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { useTranslation } from "react-i18next";
import type { Occurrence } from "../../api.js";
import { toLocal } from "../../lib/recurrence.js";

/**
 * Month and week view of an event's occurrences, in the event's timezone. FullCalendar gets
 * wall-clock times without an offset, so it shows them as they are, whatever the browser's zone.
 */
export function OccurrenceCalendar({ occurrences, timezone, title, onSelect }: {
  occurrences: Occurrence[];
  timezone: string;
  title: string;
  onSelect(o: Occurrence): void;
}) {
  const { t, i18n } = useTranslation();
  const byId = new Map(occurrences.map((o) => [o.id, o]));
  const events: EventInput[] = occurrences.map((o) => ({
    id: o.id,
    title: [o.status === "cancelled" ? t("occurrences.cancelled") : null, o.conflict ? t("series.badge.conflict") : null, title].filter(Boolean).join(" · "),
    start: toLocal(o.startUtc, timezone),
    end: toLocal(o.endUtc, timezone),
    classNames: [
      "em-occ",
      o.status === "cancelled" ? "em-occ-cancelled" : "",
      o.conflict ? "em-occ-conflict" : o.detached ? "em-occ-detached" : "",
    ],
  }));
  const first = occurrences.find((o) => new Date(o.endUtc) > new Date()) ?? occurrences[0];

  return (
    <div className="em-calendar">
      <FullCalendar
        plugins={[dayGridPlugin, timeGridPlugin]}
        initialView="dayGridMonth"
        initialDate={first ? toLocal(first.startUtc, timezone).slice(0, 10) : undefined}
        headerToolbar={{ left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek" }}
        locales={[nbLocale, enGbLocale]}
        locale={i18n.language === "nb" ? "nb" : "en-gb"}
        timeZone="local"
        firstDay={1}
        height="auto"
        dayMaxEvents={4}
        eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        events={events}
        eventClick={(arg: EventClickArg) => {
          const o = byId.get(arg.event.id);
          if (o) onSelect(o);
        }}
      />
    </div>
  );
}
