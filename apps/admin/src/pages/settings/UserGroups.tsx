import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { etagOf, unwrap, type UserGroup } from "../../api.js";
import { useApp } from "../../AppContext.js";
import { useAccount, useUserGroups } from "../../queries.js";

const clean = (names: Record<string, string>) => Object.fromEntries(Object.entries(names).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * User groups (docs/user-groups.md): the groups the client's own site already has, such as
 * Member or Sponsor. The site signs its users in and tells the platform their group; the code
 * is what it uses, so it cannot change. A group events or ticket types are limited to stays active.
 */
export function UserGroups({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const query = useUserGroups();
  const locales = useAccount().data?.account.locales ?? [];
  const [draft, setDraft] = useState<{ code: string; names: Record<string, string> }>({ code: "", names: {} });
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const refresh = () => void qc.invalidateQueries({ queryKey: ["user-groups", accountId] });

  const create = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/v1/user-groups", { body: { code: draft.code.trim(), names: clean(draft.names) }, headers: { "Idempotency-Key": crypto.randomUUID() } })),
    onSuccess: () => {
      setDraft({ code: "", names: {} });
      toast.success(t("common.saved"));
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: async ({ g, body }: { g: UserGroup; body: { names?: Record<string, string>; archived?: boolean } }) =>
      unwrap(await api.PATCH("/v1/user-groups/{id}", { params: { path: { id: g.id } }, body, headers: { "If-Match": etagOf(g.version) } })),
    onSuccess: (g) => {
      setEdits(({ [g.id]: _, ...rest }) => rest);
      toast.success(t("common.saved"));
      refresh();
    },
  });
  const error = create.error ?? update.error;

  const nameInputs = (value: Record<string, string>, onChange: (v: Record<string, string>) => void, what: string) =>
    locales.map((l) => (
      <Input key={l} aria-label={`${what} (${l})`} placeholder={`${t("groups.name")} (${l})`} value={value[l] ?? ""}
        onChange={(e) => onChange({ ...value, [l]: e.target.value })} />
    ));

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>{t("groups.title")}</CardTitle>
        <CardDescription>{t("groups.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>{t("groups.code")}</TableHead>
                <TableHead>{t("groups.name")}</TableHead>
                <TableHead className="w-28">{t("groups.active")}</TableHead>
                {canEdit && <TableHead className="w-20"><span className="sr-only">{t("common.save")}</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((g) => {
                const names = edits[g.id] ?? g.names;
                const dirty = !same(clean(names), g.names) && Object.keys(clean(names)).length > 0;
                return (
                  <TableRow key={g.id} className={g.archived ? "text-muted-foreground" : ""}>
                    <TableCell className="align-top">
                      <code className="text-xs">{g.code}</code>
                      {g.usedBy > 0 && <Badge variant="outline" className="ml-2 font-normal">{t("groups.usedBy", { count: g.usedBy })}</Badge>}
                    </TableCell>
                    <TableCell>
                      {canEdit ? (
                        <div className="flex flex-col gap-2 sm:flex-row">{nameInputs(names, (v) => setEdits({ ...edits, [g.id]: v }), `${t("groups.name")} ${g.code}`)}</div>
                      ) : (
                        Object.values(g.names).join(" / ")
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      <Switch checked={!g.archived} disabled={!canEdit || update.isPending || (!g.archived && g.usedBy > 0)}
                        title={!g.archived && g.usedBy > 0 ? t("groups.inUse") : undefined} aria-label={`${t("groups.active")} ${g.code}`}
                        onCheckedChange={(on) => update.mutate({ g, body: { archived: !on } })} />
                    </TableCell>
                    {canEdit && (
                      <TableCell className="align-top">
                        <Button size="sm" variant="outline" disabled={!dirty || update.isPending} onClick={() => update.mutate({ g, body: { names: clean(names) } })}>
                          {t("common.save")}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
              {query.data?.length === 0 && (
                <TableRow><TableCell colSpan={canEdit ? 4 : 3} className="h-16 text-center text-muted-foreground">{t("groups.empty")}</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {canEdit && (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Input aria-label={t("groups.code")} placeholder={t("groups.codePlaceholder")} required pattern="[a-z0-9][a-z0-9_\-]*" className="sm:w-36 sm:shrink-0"
              value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toLowerCase() })} />
            {nameInputs(draft.names, (names) => setDraft({ ...draft, names }), t("groups.name"))}
            <Button type="submit" disabled={create.isPending || !draft.code.trim() || Object.keys(clean(draft.names)).length === 0}><Plus /> {t("groups.add")}</Button>
          </form>
        )}
        <p className="text-xs text-muted-foreground">{t("groups.hint")}</p>
      </CardContent>
    </Card>
  );
}
