import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, CircleAlert, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { etagOf, type Tag, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { useAccount, useLabel, useVocabularies } from "../../queries.js";
import { slugKey } from "./slug.js";

/**
 * Tag vocabularies (category, audience…) and their tags. Labels are entered in every
 * account language; the key is derived from the first label and used in the public API.
 */
export function TagVocabularies({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const vocabs = useVocabularies();
  const locales = useAccount().data?.account.locales ?? [];
  const label = useLabel();
  const [newVocab, setNewVocab] = useState<Record<string, string>>({});
  const [newTag, setNewTag] = useState<Record<string, Record<string, string>>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ["tag-vocabularies", accountId] });

  const clean = (labels: Record<string, string>) => Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));

  const createVocab = useMutation({
    mutationFn: async (labels: Record<string, string>) =>
      unwrap(await api.POST("/v1/tag-vocabularies", { body: { key: slugKey(Object.values(labels)[0] ?? ""), labels } })),
    onSuccess: () => {
      setNewVocab({});
      void refresh();
    },
  });
  const createTag = useMutation({
    mutationFn: async ({ vocabularyId, labels }: { vocabularyId: string; labels: Record<string, string> }) =>
      unwrap(await api.POST("/v1/tag-vocabularies/{id}/tags", { params: { path: { id: vocabularyId } }, body: { key: slugKey(Object.values(labels)[0] ?? ""), labels } })),
    onSuccess: (_d, v) => {
      setNewTag({ ...newTag, [v.vocabularyId]: {} });
      void refresh();
    },
  });
  const archiveTag = useMutation({
    mutationFn: async (tag: Tag) =>
      unwrap(await api.PATCH("/v1/tags/{id}", { params: { path: { id: tag.id } }, body: { archived: !tag.archived }, headers: { "If-Match": etagOf(tag.version) } })),
    onSuccess: () => void refresh(),
  });
  const error = createVocab.error ?? createTag.error ?? archiveTag.error;

  const labelInputs = (value: Record<string, string>, onChange: (v: Record<string, string>) => void, idPrefix: string, placeholder: string) =>
    locales.map((l) => (
      <Input
        key={l}
        aria-label={`${placeholder} (${l})`}
        placeholder={`${placeholder} (${l})`}
        id={`${idPrefix}-${l}`}
        value={value[l] ?? ""}
        onChange={(e) => onChange({ ...value, [l]: e.target.value })}
      />
    ));

  return (
    <Card className="mt-10">
      <CardHeader>
        <CardTitle>{t("tags.title")}</CardTitle>
        <CardDescription>{t("tags.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        {(vocabs.data ?? []).map((v) => (
          <div key={v.id} className="space-y-2">
            <div className="flex items-baseline gap-2">
              <h3 className="font-medium">{label(v)}</h3>
              <code className="text-xs text-muted-foreground">{v.key}</code>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {v.tags.map((tag) => (
                <Badge key={tag.id} variant={tag.archived ? "outline" : "secondary"} className={tag.archived ? "text-muted-foreground line-through" : ""}>
                  {label(tag)}
                  {canEdit && (
                    <button
                      type="button"
                      className="ml-1 opacity-60 hover:opacity-100"
                      aria-label={`${tag.archived ? t("locations.restore") : t("locations.archive")} ${label(tag)}`}
                      onClick={() => archiveTag.mutate(tag)}
                    >
                      {tag.archived ? <ArchiveRestore className="size-3" /> : <Archive className="size-3" />}
                    </button>
                  )}
                </Badge>
              ))}
              {v.tags.length === 0 && <span className="text-sm text-muted-foreground">{t("tags.noTags")}</span>}
            </div>
            {canEdit && (
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  const labels = clean(newTag[v.id] ?? {});
                  if (Object.keys(labels).length) createTag.mutate({ vocabularyId: v.id, labels });
                }}
              >
                {labelInputs(newTag[v.id] ?? {}, (x) => setNewTag({ ...newTag, [v.id]: x }), `tag-${v.id}`, t("tags.newTag"))}
                <Button type="submit" variant="outline" disabled={createTag.isPending}><Plus /> {t("tags.addTag")}</Button>
              </form>
            )}
          </div>
        ))}
        {canEdit && (
          <form
            className="flex flex-col gap-2 border-t pt-4 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              const labels = clean(newVocab);
              if (Object.keys(labels).length) createVocab.mutate(labels);
            }}
          >
            {labelInputs(newVocab, setNewVocab, "vocab", t("tags.newVocabulary"))}
            <Button type="submit" disabled={createVocab.isPending}><Plus /> {t("tags.addVocabulary")}</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
