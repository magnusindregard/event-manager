import { useQuery } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useParams, useSearchParams } from "react-router";
import { formatInZone } from "@/components/zoned-datetime";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { downloadDoorList } from "./door-list.js";

/**
 * The door list for one occurrence (docs/registration.md, "door list"): confirmed attendees in
 * name order with party size and source, and optionally the form's answers. Laid out for
 * printing; the browser's print dialog also saves it as PDF.
 */
export function DoorListPage() {
  const { t, i18n } = useTranslation();
  const { api, accountId, can } = useApp();
  const { occurrenceId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const answers = params.get("answers") === "1";

  const occurrence = useQuery({
    queryKey: ["occurrence", accountId, occurrenceId],
    queryFn: async () => unwrap(await api.GET("/v1/occurrences/{id}", { params: { path: { id: occurrenceId } } })),
  });
  const event = useQuery({
    queryKey: ["event", accountId, occurrence.data?.eventId],
    enabled: !!occurrence.data,
    queryFn: async () => unwrap(await api.GET("/v1/events/{id}", { params: { path: { id: occurrence.data!.eventId } } })),
  });
  const list = useQuery({
    queryKey: ["door-list", accountId, occurrenceId, answers, i18n.language],
    queryFn: async () => unwrap(await api.GET("/v1/occurrences/{id}/door-list", { params: { path: { id: occurrenceId }, query: { answers, locale: i18n.language } } })),
  });

  if (!can("registrations.read")) return <p className="p-6">{t("doorList.noAccess")}</p>;
  const ev = event.data;
  const title = ev ? (ev.translations[i18n.language]?.title ?? Object.values(ev.translations)[0]?.title ?? ev.slug) : "";
  const when = occurrence.data && ev ? formatInZone(occurrence.data.startUtc, ev.timezone, i18n.language) : "";
  const d = list.data;
  const sensitive = d?.columns.some((c) => c.sensitive);

  return (
    <div className="mx-auto max-w-5xl p-6 print:max-w-none print:p-0">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button variant="link" asChild className="px-0">
          <Link to={ev ? `/events/${ev.id}` : "/events"}>← {t("doorList.back")}</Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Checkbox id="with-answers" checked={answers} onCheckedChange={(v) => setParams(v === true ? { answers: "1" } : {})} />
            <Label htmlFor="with-answers" className="font-normal">{t("doorList.withAnswers")}</Label>
          </div>
          <Button variant="outline" onClick={() => void downloadDoorList(api, occurrenceId, answers, i18n.language)}><Download /> {t("doorList.csv")}</Button>
          <Button onClick={() => window.print()}><Printer /> {t("doorList.print")}</Button>
        </div>
      </div>
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{when}</p>
        {d && <p className="mt-1 text-sm">{t("doorList.totals", { count: d.totals.registrations, people: d.totals.people })}</p>}
        {sensitive && <p className="mt-1 text-xs text-muted-foreground">{t("doorList.sensitiveNote")}</p>}
      </header>
      {list.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading", "…")}</p>
      ) : d && d.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("registrations.empty")}</p>
      ) : d ? (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="w-10 py-2 pr-2"><span className="sr-only">{t("doorList.arrived")}</span></th>
              <th scope="col" className="py-2 pr-4">{t("registrations.name")}</th>
              <th scope="col" className="py-2 pr-4 text-right">{t("registrations.party")}</th>
              <th scope="col" className="py-2 pr-4">{t("registrations.source")}</th>
              {d.columns.map((c) => <th key={c.fieldId} scope="col" className="py-2 pr-4">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {d.entries.map((e) => (
              <tr key={e.registrationId} className="border-b align-top break-inside-avoid">
                <td className="py-2 pr-2"><span aria-hidden className="inline-block size-4 rounded-sm border border-foreground/60" /></td>
                <td className="py-2 pr-4">
                  <span className="font-medium">{e.name}</span>
                  <span className="block text-xs text-muted-foreground">{e.email}</span>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{e.partySize}</td>
                <td className="py-2 pr-4">{t(`registrations.sources.${e.source}`)}</td>
                {d.columns.map((c) => <td key={c.fieldId} className="py-2 pr-4 whitespace-pre-line">{e.answers[c.fieldId] ?? ""}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p role="alert" className="text-sm text-destructive">{t("error.generic")}</p>
      )}
    </div>
  );
}
