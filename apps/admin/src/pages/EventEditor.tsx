import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { LocationSelect, TagPicker } from "@/components/catalog-fields";
import { Combobox } from "@/components/combobox";
import { ConflictDialog } from "@/components/conflict-dialog";
import { Field, PageHeader } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApiProblem, type CatalogEvent, isConflict, unwrap } from "../api.js";
import { useApp } from "../AppContext.js";
import { useAccount } from "../queries.js";
import { Audit } from "./Audit.js";
import { eventTitle, statusVariant } from "./Events.js";
import { Occurrences } from "./Occurrences.js";
import { Rules } from "./Rules.js";

const TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["Europe/Oslo", "UTC"];
  }
})();

type T = { title: string; shortDescription: string; imageUrl: string; imageAlt: string };
type Form = {
  slug: string;
  timezone: string;
  defaultLocationId: string | null;
  defaultDurationMin: number;
  external: boolean;
  externalUrl: string;
  tagIds: string[];
  refs: { key: string; value: string }[];
  translations: Record<string, T>;
};

const emptyT: T = { title: "", shortDescription: "", imageUrl: "", imageAlt: "" };

function toForm(e: CatalogEvent | null, locales: string[], timezone: string): Form {
  return {
    slug: e?.slug ?? "",
    timezone: e?.timezone ?? timezone,
    defaultLocationId: e?.defaultLocationId ?? null,
    defaultDurationMin: e?.defaultDurationMin ?? 60,
    external: e?.admissionMode === "external",
    externalUrl: e?.externalUrl ?? "",
    tagIds: e?.tagIds ?? [],
    refs: Object.entries(e?.externalRefs ?? {}).map(([key, value]) => ({ key, value })),
    translations: Object.fromEntries(
      locales.map((l) => {
        const t = e?.translations[l];
        return [l, t ? { title: t.title, shortDescription: t.shortDescription ?? "", imageUrl: t.imageUrl ?? "", imageAlt: t.imageAlt ?? "" } : emptyT];
      }),
    ),
  };
}

function toBody(f: Form, before: CatalogEvent | null) {
  const translations: Record<string, { title: string; shortDescription: string | null; imageUrl: string | null; imageAlt: string | null } | null> = {};
  for (const [locale, t] of Object.entries(f.translations)) {
    if (t.title.trim()) {
      translations[locale] = { title: t.title.trim(), shortDescription: t.shortDescription.trim() || null, imageUrl: t.imageUrl.trim() || null, imageAlt: t.imageAlt.trim() || null };
    } else if (before?.translations[locale]) {
      translations[locale] = null;
    }
  }
  return {
    ...(f.slug.trim() ? { slug: f.slug.trim() } : {}),
    timezone: f.timezone,
    defaultLocationId: f.defaultLocationId,
    defaultDurationMin: f.defaultDurationMin,
    admissionMode: f.external ? ("external" as const) : ("none" as const),
    externalUrl: f.externalUrl.trim() || null,
    tagIds: f.tagIds,
    externalRefs: Object.fromEntries(f.refs.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])),
    translations,
  };
}

/** Problem details for a field, from a 422 response. */
function fieldOf(e: unknown): string | undefined {
  return e instanceof ApiProblem ? e.field : undefined;
}

export function EventEditor() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const isNew = id === "new";

  const query = useQuery({
    queryKey: ["event", accountId, id],
    enabled: !isNew,
    queryFn: async () => {
      const r = await api.GET("/v1/events/{id}", { params: { path: { id: id! } } });
      return { event: unwrap(r), etag: r.response.headers.get("etag") ?? "" };
    },
  });
  const event = query.data?.event ?? null;

  const transition = useMutation({
    mutationFn: async (action: "publish" | "unpublish" | "cancel" | "archive") => {
      const opts = { params: { path: { id: id! } }, headers: { "If-Match": query.data!.etag } };
      const path = `/v1/events/{id}/${action}` as const;
      const r = await api.POST(path, opts);
      return { event: unwrap(r), etag: r.response.headers.get("etag") ?? "" };
    },
    onSuccess: (data) => {
      qc.setQueryData(["event", accountId, id], data);
      void qc.invalidateQueries({ queryKey: ["events", accountId] });
      toast.success(t(`events.statuses.${data.event.status}`));
    },
  });

  if (!isNew && query.isError) {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription>{query.error instanceof ApiProblem && query.error.status === 404 ? t("events.notFound") : t("error.generic")}</AlertDescription>
      </Alert>
    );
  }
  if (!isNew && !event) return null;

  const actions = event
    ? (
        [
          ["publish", ["draft", "cancelled"]],
          ["unpublish", ["published"]],
          ["cancel", ["draft", "published"]],
          ["archive", ["draft", "published", "cancelled"]],
        ] as const
      ).filter(([, from]) => (from as readonly string[]).includes(event.status))
    : [];

  return (
    <div>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link to="/events"><ArrowLeft /> {t("events.listTitle")}</Link>
      </Button>
      <PageHeader
        title={event ? eventTitle(event, i18n.language) : t("events.new")}
        description={event && <Badge variant={statusVariant(event.status)}>{t(`events.statuses.${event.status}`)}</Badge>}
        actions={actions.map(([a]) => (
          <Button key={a} variant={a === "publish" ? "default" : "outline"} disabled={transition.isPending} onClick={() => transition.mutate(a)}>
            {t(`events.actions.${a}`)}
          </Button>
        ))}
      />
      {transition.error && (
        <Alert variant="destructive" className="mb-4">
          <CircleAlert />
          <AlertDescription>{transition.error.message}</AlertDescription>
        </Alert>
      )}
      {isNew ? (
        <EventDetails event={null} etag="" />
      ) : (
        <Tabs defaultValue="details">
          <TabsList>
            <TabsTrigger value="details">{t("events.tabs.details")}</TabsTrigger>
            <TabsTrigger value="occurrences">{t("events.tabs.occurrences")}</TabsTrigger>
            <TabsTrigger value="rules">{t("events.tabs.rules")}</TabsTrigger>
            <TabsTrigger value="audit">{t("events.tabs.audit")}</TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="pt-4">
            <EventDetails event={event} etag={query.data!.etag} />
          </TabsContent>
          <TabsContent value="occurrences" className="pt-4">
            <Occurrences event={event!} />
          </TabsContent>
          <TabsContent value="rules" className="pt-4">
            <Rules event={event!} />
          </TabsContent>
          <TabsContent value="audit" className="pt-4">
            <Audit entityType="event" entityId={event!.id} embedded />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function EventDetails({ event, etag }: { event: CatalogEvent | null; etag: string }) {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const accountQuery = useAccount();
  const account = accountQuery.data?.account;
  const [form, setForm] = useState<Form | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (account) setForm(toForm(event, account.locales, account.defaultTimezone));
  }, [event, account]);

  const save = useMutation({
    mutationFn: async (f: Form) => {
      if (!event) {
        const body = toBody(f, null);
        const translations = Object.fromEntries(Object.entries(body.translations).filter((e): e is [string, NonNullable<(typeof e)[1]>] => e[1] !== null));
        return unwrap(await api.POST("/v1/events", { body: { ...body, translations } }));
      }
      const r = await api.PATCH("/v1/events/{id}", { params: { path: { id: event.id } }, body: toBody(f, event), headers: { "If-Match": etag } });
      const updated = unwrap(r);
      qc.setQueryData(["event", accountId, event.id], { event: updated, etag: r.response.headers.get("etag") ?? "" });
      return updated;
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ["events", accountId] });
      toast.success(t("common.saved"));
      if (!event) navigate(`/events/${saved.id}`, { replace: true });
    },
    onError: (e) => isConflict(e) && setConflict(true),
  });

  if (!form || !account) return null;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const setT = (locale: string, patch: Partial<T>) => setForm({ ...form, translations: { ...form.translations, [locale]: { ...form.translations[locale]!, ...patch } } });
  const localeName = (code: string) => {
    try {
      const name = new Intl.DisplayNames([i18n.language], { type: "language" }).of(code) ?? code;
      return name.charAt(0).toLocaleUpperCase(i18n.language) + name.slice(1);
    } catch {
      return code;
    }
  };
  const errField = fieldOf(save.error);
  const otherError = save.error && !isConflict(save.error);

  return (
    <form
      className="max-w-2xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(form);
      }}
    >
      {otherError && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{save.error.message}{errField && ` (${errField})`}</AlertDescription>
        </Alert>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium">{t("events.texts")}</h2>
        <Tabs defaultValue={account.defaultLocale}>
          <TabsList>
            {account.locales.map((l) => (
              <TabsTrigger key={l} value={l}>
                {localeName(l)}
                {l === account.defaultLocale && " *"}
              </TabsTrigger>
            ))}
          </TabsList>
          {account.locales.map((l) => {
            const tr = form.translations[l] ?? emptyT;
            return (
              <TabsContent key={l} value={l} className="grid gap-4 pt-2">
                <Field label={t("events.title")} htmlFor={`title-${l}`} hint={l === account.defaultLocale ? t("events.defaultLocaleRequired") : t("events.optionalLocale")}>
                  <Input id={`title-${l}`} value={tr.title} required={l === account.defaultLocale} onChange={(e) => setT(l, { title: e.target.value })} />
                </Field>
                <Field label={t("events.shortDescription")} htmlFor={`desc-${l}`}>
                  <Textarea id={`desc-${l}`} rows={3} value={tr.shortDescription} onChange={(e) => setT(l, { shortDescription: e.target.value })} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("events.imageUrl")} htmlFor={`img-${l}`}>
                    <Input id={`img-${l}`} type="url" value={tr.imageUrl} onChange={(e) => setT(l, { imageUrl: e.target.value })} />
                  </Field>
                  <Field label={t("events.imageAlt")} htmlFor={`alt-${l}`}>
                    <Input id={`alt-${l}`} value={tr.imageAlt} onChange={(e) => setT(l, { imageAlt: e.target.value })} />
                  </Field>
                </div>
              </TabsContent>
            );
          })}
        </Tabs>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Field label={t("events.slug")} htmlFor="slug" hint={event ? undefined : t("events.slugHint")} className="sm:col-span-2">
          <Input id="slug" value={form.slug} pattern="[a-z0-9]+(-[a-z0-9]+)*" onChange={(e) => set("slug", e.target.value.toLowerCase())} aria-invalid={errField === "slug"} />
        </Field>
        <Field label={t("events.timezone")} htmlFor="timezone">
          <Combobox id="timezone" options={TIMEZONES} value={form.timezone} onChange={(v) => set("timezone", v)} searchPlaceholder={t("common.search")} emptyText={t("common.noResults")} />
        </Field>
        <Field label={t("events.duration")} htmlFor="duration">
          <Input id="duration" type="number" min={1} value={form.defaultDurationMin} onChange={(e) => set("defaultDurationMin", Number(e.target.value))} />
        </Field>
        <Field label={t("events.defaultLocation")} htmlFor="location" className="sm:col-span-2">
          <LocationSelect id="location" value={form.defaultLocationId} onChange={(v) => set("defaultLocationId", v)} noneLabel={t("events.noLocation")} />
        </Field>
        <Field label={t("events.tags")} htmlFor="tags" className="sm:col-span-2">
          <TagPicker id="tags" value={form.tagIds} onChange={(v) => set("tagIds", v)} />
        </Field>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Switch id="external" checked={form.external} onCheckedChange={(v) => set("external", v)} />
          <Label htmlFor="external">{t("events.externalAdmission")}</Label>
        </div>
        {form.external && (
          <Field label={t("events.externalUrl")} htmlFor="external-url" hint={t("events.externalUrlHint")}>
            <Input id="external-url" type="url" required value={form.externalUrl} onChange={(e) => set("externalUrl", e.target.value)} />
          </Field>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("events.externalRefs")}</h2>
        <p className="text-xs text-muted-foreground">{t("events.externalRefsHint")}</p>
        {form.refs.map((r, i) => (
          <div key={i} className="flex gap-2">
            <Input aria-label={t("events.refSystem")} placeholder="sanity" className="w-40" value={r.key} onChange={(e) => set("refs", form.refs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            <Input aria-label={t("events.refId")} placeholder="event-123" value={r.value} onChange={(e) => set("refs", form.refs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <Button type="button" variant="ghost" size="icon" aria-label={t("common.remove")} onClick={() => set("refs", form.refs.filter((_, j) => j !== i))}>
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => set("refs", [...form.refs, { key: "", value: "" }])}>
          <Plus /> {t("events.addRef")}
        </Button>
      </section>

      <Button type="submit" disabled={save.isPending}>{event ? t("common.save") : t("events.create")}</Button>

      <ConflictDialog
        open={conflict}
        onOpenChange={setConflict}
        onReload={() => void qc.invalidateQueries({ queryKey: ["event", accountId, event?.id] })}
      />
    </form>
  );
}
