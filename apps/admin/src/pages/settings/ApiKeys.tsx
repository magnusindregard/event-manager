import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";

type Kind = "publishable" | "preview";

/** Public API keys (owner only). The full key is shown once, right after creation. */
export function ApiKeys() {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<Kind>("publishable");
  const [secret, setSecret] = useState<string | null>(null);
  const key = ["api-keys", accountId];
  const query = useQuery({ queryKey: key, queryFn: async () => unwrap(await api.GET("/v1/api-keys")).items });

  const create = useMutation({
    mutationFn: async () => unwrap(await api.POST("/v1/api-keys", { body: { kind, label } })),
    onSuccess: (k) => {
      setSecret(k.secret);
      setLabel("");
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const r = await api.DELETE("/v1/api-keys/{id}", { params: { path: { id } } });
      if (r.error) unwrap(r);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  const error = create.error ?? revoke.error;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>{t("apiKeys.title")}</CardTitle>
        <CardDescription>{t("apiKeys.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        {secret && (
          <Alert>
            <KeyRound />
            <AlertTitle>{t("apiKeys.copyNow")}</AlertTitle>
            <AlertDescription className="space-y-2">
              <code className="block break-all rounded bg-muted px-2 py-1 text-xs text-foreground">{secret}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(secret).then(() => toast.success(t("apiKeys.copied")));
                }}
              >
                <Copy /> {t("apiKeys.copy")}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Input aria-label={t("apiKeys.label")} placeholder={t("apiKeys.label")} required value={label} onChange={(e) => setLabel(e.target.value)} />
          <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
            <SelectTrigger aria-label={t("apiKeys.kind")} className="w-full sm:w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="publishable">{t("apiKeys.kinds.publishable")}</SelectItem>
              <SelectItem value="preview">{t("apiKeys.kinds.preview")}</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" disabled={create.isPending}><Plus /> {t("apiKeys.create")}</Button>
        </form>
        <p className="text-xs text-muted-foreground">{t(`apiKeys.hints.${kind}`)}</p>
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>{t("apiKeys.label")}</TableHead>
                <TableHead>{t("apiKeys.kind")}</TableHead>
                <TableHead>{t("apiKeys.created")}</TableHead>
                <TableHead className="w-12"><span className="sr-only">{t("apiKeys.revoke")}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((k) => (
                <TableRow key={k.id} className={k.revokedAt ? "text-muted-foreground" : ""}>
                  <TableCell>
                    <div className="font-medium">{k.label}</div>
                    <code className="text-xs">{k.prefix}_…</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{t(`apiKeys.kinds.${k.kind}`)}</Badge>
                    {k.revokedAt && <Badge variant="secondary" className="ml-1">{t("apiKeys.revoked")}</Badge>}
                  </TableCell>
                  <TableCell>{fmt.format(new Date(k.createdAt))}</TableCell>
                  <TableCell>
                    {!k.revokedAt && (
                      <Button variant="ghost" size="icon" aria-label={`${t("apiKeys.revoke")} ${k.label}`} disabled={revoke.isPending} onClick={() => revoke.mutate(k.id)}>
                        <Trash2 />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {query.data?.length === 0 && (
                <TableRow><TableCell colSpan={4} className="h-16 text-center text-muted-foreground">{t("apiKeys.empty")}</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
