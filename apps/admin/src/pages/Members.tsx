import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { unwrap } from "../api.js";
import { useApp } from "../AppContext.js";

type Role = "owner" | "editor";

export function Members() {
  const { t } = useTranslation();
  const { api, accountId, roles, me } = useApp();
  const qc = useQueryClient();
  const isOwner = roles.includes("owner");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");

  const query = useQuery({ queryKey: ["members", accountId], queryFn: async () => unwrap(await api.GET("/v1/account/members")) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["members", accountId] });

  const invite = useMutation({
    mutationFn: async () => unwrap(await api.POST("/v1/account/invitations", { body: { email, role } })),
    onSuccess: () => {
      setEmail("");
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: async (userId: string) => {
      const r = await api.DELETE("/v1/account/members/{userId}", { params: { path: { userId } } });
      if (r.error) unwrap(r);
    },
    onSuccess: () => void refresh(),
  });

  const error = invite.error ?? remove.error;
  const roleLabel = (r: string) => t(`members.roles.${r}`, r);

  return (
    <div className="max-w-3xl">
      <PageHeader title={t("members.title")} />
      <div className="space-y-6">
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {isOwner && (
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              invite.mutate();
            }}
          >
            <div className="grid flex-1 gap-2">
              <Label htmlFor="invite-email">{t("members.email")}</Label>
              <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-role">{t("members.role")}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                <SelectTrigger id="invite-role" className="w-full sm:w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="editor">{roleLabel("editor")}</SelectItem>
                  <SelectItem value="owner">{roleLabel("owner")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={invite.isPending}>{t("members.invite")}</Button>
          </form>
        )}

        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>{t("members.user")}</TableHead>
                <TableHead>{t("members.role")}</TableHead>
                <TableHead className="w-12"><span className="sr-only">{t("members.remove")}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data?.members.map((m) => (
                <TableRow key={m.userId}>
                  <TableCell>
                    <div className="font-medium">{m.name ?? m.email}</div>
                    {m.name && <div className="text-xs text-muted-foreground">{m.email}</div>}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {m.roles.map((r) => <Badge key={r} variant="secondary">{roleLabel(r)}</Badge>)}
                    </div>
                  </TableCell>
                  <TableCell>
                    {isOwner && m.userId !== me?.userId && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${t("members.remove")} ${m.email}`}
                        onClick={() => remove.mutate(m.userId)}
                        disabled={remove.isPending}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {query.data?.invitations.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <div className="font-medium">{i.email}</div>
                    <div className="text-xs text-muted-foreground">{t("members.pending")}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{roleLabel(i.role)}</Badge>
                  </TableCell>
                  <TableCell />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
