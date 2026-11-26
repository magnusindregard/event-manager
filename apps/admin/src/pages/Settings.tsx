import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Combobox } from "@/components/combobox";
import { Field, PageHeader } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConflictDialog } from "@/components/conflict-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type Account, ApiProblem, unwrap } from "../api.js";
import { useApp } from "../AppContext.js";
import { useAccount } from "../queries.js";
import { ApiKeys } from "./settings/ApiKeys.js";
import { Integrations } from "./settings/Integrations.js";
import { Payments } from "./settings/Payments.js";
import { SalesChannels, SkuMappings } from "./settings/SalesChannels.js";
import { TagVocabularies } from "./settings/TagVocabularies.js";
import { UserGroups } from "./settings/UserGroups.js";
import { VatClasses } from "./settings/VatClasses.js";

const TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["Europe/Oslo", "UTC"];
  }
})();
const LOCALE_OPTIONS = ["nb", "nn", "en", "se", "sv", "da", "de", "fr"];

type Form = Pick<Account, "name" | "defaultTimezone" | "defaultLocale" | "locales" | "horizonMonths" | "anonymiseAfterMonths" | "sensitiveDeleteAfterDays">;

export function Settings() {
  const { t, i18n } = useTranslation();
  const { api, accountId, roles } = useApp();
  const qc = useQueryClient();
  const canEdit = roles.includes("owner");
  const [form, setForm] = useState<Form | null>(null);
  const [conflict, setConflict] = useState(false);
  const localeName = (code: string) => {
    try {
      return `${new Intl.DisplayNames([i18n.language], { type: "language" }).of(code) ?? code} (${code})`;
    } catch {
      return code;
    }
  };

  const query = useAccount();

  useEffect(() => {
    if (query.data) {
      const { name, defaultTimezone, defaultLocale, locales, horizonMonths, anonymiseAfterMonths, sensitiveDeleteAfterDays } = query.data.account;
      setForm({ name, defaultTimezone, defaultLocale, locales, horizonMonths, anonymiseAfterMonths, sensitiveDeleteAfterDays });
    }
  }, [query.data]);

  const save = useMutation({
    mutationFn: async (body: Form) => {
      const r = await api.PATCH("/v1/account", { body, headers: { "If-Match": query.data!.etag } });
      return { account: unwrap(r), etag: r.response.headers.get("etag") ?? "" };
    },
    onSuccess: (data) => {
      qc.setQueryData(["account", accountId], data);
      void qc.invalidateQueries({ queryKey: ["me"] });
      toast.success(t("settings.saved"));
    },
    onError: (e) => {
      if (e instanceof ApiProblem && e.code === "version_conflict") setConflict(true);
    },
  });

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription>{t("error.generic")}</AlertDescription>
      </Alert>
    );
  }
  if (!form) return null;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const otherError = save.error && !(save.error instanceof ApiProblem && save.error.code === "version_conflict");

  return (
    <div className="max-w-xl">
      <PageHeader title={t("settings.title")} />
      <div className="space-y-4">
        {!canEdit && (
          <Alert>
            <Info />
            <AlertDescription>{t("settings.ownerOnly")}</AlertDescription>
          </Alert>
        )}
        {otherError && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{save.error.message}</AlertDescription>
          </Alert>
        )}

        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(form);
          }}
        >
          <Field label={t("settings.name")} htmlFor="name">
            <Input id="name" value={form.name} onChange={(e) => set("name", e.target.value)} required disabled={!canEdit} />
          </Field>
          <Field label={t("settings.timezone")} htmlFor="timezone">
            <Combobox
              id="timezone"
              options={TIMEZONES}
              value={form.defaultTimezone}
              onChange={(v) => set("defaultTimezone", v)}
              disabled={!canEdit}
              searchPlaceholder={t("common.search")}
              emptyText={t("common.noResults")}
            />
          </Field>
          <Field label={t("settings.locales")} htmlFor="locales">
            <Combobox
              id="locales"
              multiple
              options={LOCALE_OPTIONS}
              value={form.locales}
              label={localeName}
              onChange={(v) => setForm({ ...form, locales: v, defaultLocale: v.includes(form.defaultLocale) ? form.defaultLocale : (v[0] ?? "") })}
              disabled={!canEdit}
              searchPlaceholder={t("common.search")}
              emptyText={t("common.noResults")}
            />
          </Field>
          <Field label={t("settings.defaultLocale")} htmlFor="defaultLocale">
            <Select value={form.defaultLocale} onValueChange={(v) => set("defaultLocale", v)} disabled={!canEdit}>
              <SelectTrigger id="defaultLocale" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {form.locales.map((l) => <SelectItem key={l} value={l}>{localeName(l)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("settings.horizon")} htmlFor="horizon">
            <Input
              id="horizon"
              type="number"
              min={1}
              max={60}
              className="w-32"
              value={form.horizonMonths}
              onChange={(e) => set("horizonMonths", Number(e.target.value))}
              disabled={!canEdit}
            />
          </Field>
          <fieldset className="grid gap-4 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">{t("settings.privacy")}</legend>
            <Field label={t("settings.anonymiseAfter")} htmlFor="anonymise" hint={t("settings.anonymiseHint")}>
              <Input id="anonymise" type="number" min={1} max={120} className="w-32" value={form.anonymiseAfterMonths}
                onChange={(e) => set("anonymiseAfterMonths", Number(e.target.value))} disabled={!canEdit} />
            </Field>
            <Field label={t("settings.sensitiveAfter")} htmlFor="sensitive" hint={t("settings.sensitiveHint")}>
              <Input id="sensitive" type="number" min={1} max={365} className="w-32" value={form.sensitiveDeleteAfterDays}
                onChange={(e) => set("sensitiveDeleteAfterDays", Number(e.target.value))} disabled={!canEdit} />
            </Field>
          </fieldset>
          {canEdit && <Button type="submit" disabled={save.isPending}>{t("settings.save")}</Button>}
        </form>
      </div>

      <TagVocabularies canEdit={canEdit} />
      <UserGroups canEdit={canEdit} />
      <VatClasses canEdit={canEdit} />
      <SalesChannels canEdit={canEdit} />
      <SkuMappings canEdit={canEdit} />
      <Integrations canEdit={canEdit} />
      <Payments canEdit={canEdit} />
      {canEdit && <ApiKeys />}

      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => void query.refetch()} />
    </div>
  );
}
