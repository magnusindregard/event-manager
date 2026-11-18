import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Lock, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConflictDialog } from "@/components/conflict-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiProblem, type CatalogEvent, type FormField, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { useAccount } from "../../queries.js";

// The event's registration form (docs/registration.md, "Form fields"). Name, email and the
// guest are always asked; these are the extra fields. Saving makes a new version, so answers
// given to the old form stay readable. Building the form is content (content.write).

type FieldType = FormField["type"];
const TYPES: FieldType[] = ["text", "dietary", "checkbox", "choice"];

interface Draft {
  key: string;
  id?: string;
  type: FieldType;
  label: Record<string, string>;
  help: Record<string, string>;
  required: boolean;
  sensitive: boolean;
  multiline: boolean;
  multiple: boolean;
  options: { key: string; id?: string; label: Record<string, string> }[];
}

let seq = 0;
const nextKey = () => `k${++seq}`;
const toDraft = (f: FormField): Draft => ({ ...f, key: nextKey(), options: f.options.map((o) => ({ ...o, key: nextKey() })) });
const blank = (type: FieldType): Draft => ({
  key: nextKey(), type, label: {}, help: {}, required: false, sensitive: type === "dietary", multiline: type === "dietary", multiple: false,
  options: type === "choice" ? [{ key: nextKey(), label: {} }, { key: nextKey(), label: {} }] : [],
});
const clean = (l: Record<string, string>) => Object.fromEntries(Object.entries(l).filter(([, v]) => v.trim()));
const toBody = (d: Draft) => ({
  ...(d.id ? { id: d.id } : {}), type: d.type, label: clean(d.label), help: clean(d.help), required: d.required,
  sensitive: d.type === "text" ? d.sensitive : undefined, multiline: d.type === "text" ? d.multiline : undefined, multiple: d.type === "choice" ? d.multiple : undefined,
  options: d.type === "choice" ? d.options.map((o) => ({ ...(o.id ? { id: o.id } : {}), label: clean(o.label) })) : undefined,
});

export function FormBuilder({ event }: { event: CatalogEvent }) {
  const { t } = useTranslation();
  const { api, accountId, can } = useApp();
  const qc = useQueryClient();
  const account = useAccount().data?.account;
  const key = ["form", accountId, event.id];
  const query = useQuery({ queryKey: key, queryFn: async () => unwrap(await api.GET("/v1/events/{id}/form", { params: { path: { id: event.id } } })) });
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<{ text: string; field?: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (query.data) setDrafts(query.data.fields.map(toDraft));
  }, [query.data]);

  const save = useMutation({
    mutationFn: async () =>
      unwrap(await api.PUT("/v1/events/{id}/form", { params: { path: { id: event.id } }, body: { version: query.data!.version, fields: drafts!.map(toBody) as never } })),
    onSuccess: (f) => {
      qc.setQueryData(key, f);
      setError(null);
      toast.success(t("form.saved", { version: f.version }));
    },
    onError: (e) => {
      if (e instanceof ApiProblem && e.status === 412) setConflict(true);
      else setError({ text: e instanceof ApiProblem && e.code === "validation_failed" ? t("form.invalid", { message: e.message }) : t("error.generic"), field: e instanceof ApiProblem ? e.field : undefined });
    },
  });

  if (!drafts || !account) return null;
  const canEdit = can("content.write");
  const locales = account.locales;
  const def = account.defaultLocale;
  const update = (i: number, patch: Partial<Draft>) => setDrafts(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const move = (i: number, by: number) => {
    const next = [...drafts];
    const [d] = next.splice(i, 1);
    next.splice(i + by, 0, d!);
    setDrafts(next);
  };
  const dirty = JSON.stringify(drafts.map(toBody)) !== JSON.stringify((query.data?.fields ?? []).map(toDraft).map(toBody));
  const hasDietary = drafts.some((d) => d.type === "dietary");
  const errIndex = error?.field?.match(/^fields\.(\d+)/)?.[1];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t("form.intro")}</p>
        {drafts.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t("form.empty")}</p>}
        {drafts.map((d, i) => (
          <Card key={d.key} aria-labelledby={`field-${d.key}-title`} className={errIndex === String(i) ? "border-destructive" : undefined}>
            <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
              <div className="grid gap-1">
                <CardTitle id={`field-${d.key}-title`} className="text-base">{d.label[def] || t("form.untitled")}</CardTitle>
                <CardDescription className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{t(`form.types.${d.type}`)}</Badge>
                  {(d.type === "dietary" || (d.type === "text" && d.sensitive)) && <Badge variant="outline"><Lock className="size-3" /> {t("form.sensitiveBadge")}</Badge>}
                </CardDescription>
              </div>
              {canEdit && (
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" disabled={i === 0} aria-label={t("form.moveUp")} onClick={() => move(i, -1)}><ArrowUp /></Button>
                  <Button variant="ghost" size="icon" disabled={i === drafts.length - 1} aria-label={t("form.moveDown")} onClick={() => move(i, 1)}><ArrowDown /></Button>
                  <Button variant="ghost" size="icon" aria-label={t("form.remove")} onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}><Trash2 /></Button>
                </div>
              )}
            </CardHeader>
            <CardContent className="grid gap-4">
              <fieldset className="grid gap-2" disabled={!canEdit}>
                <legend className="mb-1 text-sm font-medium">{t("form.label")}</legend>
                {locales.map((l) => (
                  <div key={l} className="flex items-center gap-2">
                    <Label htmlFor={`${d.key}-label-${l}`} className="w-8 shrink-0 text-xs uppercase text-muted-foreground">{l}</Label>
                    <Input id={`${d.key}-label-${l}`} value={d.label[l] ?? ""} maxLength={300} required={l === def} placeholder={l === def ? t("form.required") : t("form.optionalLocale")}
                      onChange={(e) => update(i, { label: { ...d.label, [l]: e.target.value } })} />
                  </div>
                ))}
              </fieldset>
              <fieldset className="grid gap-2" disabled={!canEdit}>
                <legend className="mb-1 text-sm font-medium">{t("form.help")}</legend>
                {locales.map((l) => (
                  <div key={l} className="flex items-center gap-2">
                    <Label htmlFor={`${d.key}-help-${l}`} className="w-8 shrink-0 text-xs uppercase text-muted-foreground">{l}</Label>
                    <Input id={`${d.key}-help-${l}`} value={d.help[l] ?? ""} maxLength={1000} onChange={(e) => update(i, { help: { ...d.help, [l]: e.target.value } })} />
                  </div>
                ))}
              </fieldset>
              {d.type === "choice" && (
                <fieldset className="grid gap-2" disabled={!canEdit}>
                  <legend className="mb-1 text-sm font-medium">{t("form.options")}</legend>
                  {d.options.map((o, k) => (
                    <div key={o.key} className="flex items-center gap-2">
                      <Input aria-label={t("form.optionN", { n: k + 1 })} value={o.label[def] ?? ""} maxLength={200}
                        onChange={(e) => update(i, { options: d.options.map((x, m) => (m === k ? { ...x, label: { ...x.label, [def]: e.target.value } } : x)) })} />
                      {locales.filter((l) => l !== def).map((l) => (
                        <Input key={l} aria-label={`${t("form.optionN", { n: k + 1 })} (${l})`} placeholder={l} value={o.label[l] ?? ""} maxLength={200}
                          onChange={(e) => update(i, { options: d.options.map((x, m) => (m === k ? { ...x, label: { ...x.label, [l]: e.target.value } } : x)) })} />
                      ))}
                      <Button variant="ghost" size="icon" disabled={d.options.length <= 1} aria-label={t("form.removeOption", { n: k + 1 })}
                        onClick={() => update(i, { options: d.options.filter((_, m) => m !== k) })}><Trash2 /></Button>
                    </div>
                  ))}
                  <div><Button variant="outline" size="sm" onClick={() => update(i, { options: [...d.options, { key: nextKey(), label: {} }] })}><Plus /> {t("form.addOption")}</Button></div>
                </fieldset>
              )}
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                {d.type !== "checkbox" && <Toggle id={`${d.key}-required`} label={t("form.requiredToggle")} checked={d.required} disabled={!canEdit} onChange={(v) => update(i, { required: v })} />}
                {d.type === "checkbox" && <Toggle id={`${d.key}-required`} label={t("form.mustTick")} checked={d.required} disabled={!canEdit} onChange={(v) => update(i, { required: v })} />}
                {d.type === "text" && <Toggle id={`${d.key}-multiline`} label={t("form.multiline")} checked={d.multiline} disabled={!canEdit} onChange={(v) => update(i, { multiline: v })} />}
                {d.type === "text" && <Toggle id={`${d.key}-sensitive`} label={t("form.sensitive")} checked={d.sensitive} disabled={!canEdit} onChange={(v) => update(i, { sensitive: v })} />}
                {d.type === "choice" && <Toggle id={`${d.key}-multiple`} label={t("form.multiple")} checked={d.multiple} disabled={!canEdit} onChange={(v) => update(i, { multiple: v })} />}
              </div>
              {d.type === "dietary" && <p className="text-xs text-muted-foreground">{t("form.dietaryNote", { days: account.sensitiveDeleteAfterDays })}</p>}
              {d.type === "text" && d.sensitive && <p className="text-xs text-muted-foreground">{t("form.sensitiveNote", { days: account.sensitiveDeleteAfterDays })}</p>}
            </CardContent>
          </Card>
        ))}
        {error && <Alert variant="destructive"><AlertDescription role="alert">{error.text}</AlertDescription></Alert>}
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" disabled={drafts.length >= 30}><Plus /> {t("form.add")}</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {TYPES.map((type) => (
                  <DropdownMenuItem key={type} disabled={type === "dietary" && hasDietary} onSelect={() => setDrafts([...drafts, blank(type)])}>
                    <div className="grid">
                      <span>{t(`form.types.${type}`)}</span>
                      <span className="text-xs text-muted-foreground">{t(`form.typeHelp.${type}`)}</span>
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>{t("form.save")}</Button>
            {dirty && <span className="text-xs text-muted-foreground">{t("form.unsaved")}</span>}
            {!dirty && query.data!.version > 0 && <span className="text-xs text-muted-foreground">{t("form.version", { version: query.data!.version })}</span>}
          </div>
        )}
      </div>
      <Preview drafts={drafts} locale={def} account={account.name} days={account.sensitiveDeleteAfterDays} guest={event.registration.guestAllowed} />
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => { setConflict(false); void query.refetch(); }} />
    </div>
  );
}

function Toggle({ id, label, checked, disabled, onChange }: { id: string; label: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="font-normal">{label}</Label>
    </div>
  );
}

/** What the attendee sees, in the default language. Not interactive. */
function Preview({ drafts, locale, account, days, guest }: { drafts: Draft[]; locale: string; account: string; days: number; guest: boolean }) {
  const { t } = useTranslation();
  const sensitive = drafts.some((d) => d.type === "dietary" || (d.type === "text" && d.sensitive));
  return (
    <aside aria-labelledby="form-preview" className="h-fit rounded-lg border bg-muted/30 p-4 text-sm lg:sticky lg:top-4">
      <h3 id="form-preview" className="mb-3 font-medium">{t("form.preview")}</h3>
      <div className="grid gap-3" inert>
        <PreviewText label={t("registrations.name")} />
        <PreviewText label={t("registrations.email")} />
        {guest && <PreviewCheck label={t("registrations.guest")} />}
        {drafts.map((d) => {
          const label = d.label[locale] || t("form.untitled");
          const help = d.help[locale];
          if (d.type === "checkbox") return <PreviewCheck key={d.key} label={label} help={help} />;
          if (d.type === "choice") {
            return (
              <div key={d.key} className="grid gap-1">
                <span className="font-medium">{label}{!d.required && <span className="font-normal text-muted-foreground"> {t("form.optionalMark")}</span>}</span>
                {d.options.map((o) => <PreviewCheck key={o.key} label={o.label[locale] || "…"} round={!d.multiple} />)}
                {help && <span className="text-xs text-muted-foreground">{help}</span>}
              </div>
            );
          }
          return <PreviewText key={d.key} label={label} optional={!d.required} help={help} tall={d.multiline || d.type === "dietary"} />;
        })}
        {sensitive && <div className="rounded border bg-background p-2"><PreviewCheck label={t("form.consentPreview", { account, days })} /></div>}
      </div>
    </aside>
  );
}

function PreviewText({ label, optional, help, tall }: { label: string; optional?: boolean; help?: string; tall?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1">
      <span className="font-medium">{label}{optional && <span className="font-normal text-muted-foreground"> {t("form.optionalMark")}</span>}</span>
      <div className={`rounded border bg-background ${tall ? "h-14" : "h-8"}`} />
      {help && <span className="text-xs text-muted-foreground">{help}</span>}
    </div>
  );
}

function PreviewCheck({ label, help, round }: { label: string; help?: string; round?: boolean }) {
  return (
    <div className="grid gap-1">
      <span className="flex items-start gap-2"><span className={`mt-0.5 size-4 shrink-0 border bg-background ${round ? "rounded-full" : "rounded-sm"}`} />{label}</span>
      {help && <span className="text-xs text-muted-foreground">{help}</span>}
    </div>
  );
}
