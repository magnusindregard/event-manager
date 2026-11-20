import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, RefreshCw, Trash2 } from "lucide-react";
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

type Role = "owner" | "event_manager" | "editor" | "box_office" | "finance";
type SigninKind = "auto" | "work" | "local";

export function Members() {
  const { t } = useTranslation();
  const { api, accountId, roles, me } = useApp();
  const qc = useQueryClient();
  const isOwner = roles.includes("owner");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [signinKind, setSigninKind] = useState<SigninKind>("auto");

  const query = useQuery({ queryKey: ["members", accountId], queryFn: async () => unwrap(await api.GET("/v1/account/members")) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["members", accountId] });

  const invite = useMutation({
    mutationFn: async () => unwrap(await api.POST("/v1/account/invitations", { body: { email, role, signinKind } })),
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

  const retry = useMutation({
    mutationFn: async (id: string) => unwrap(await api.POST("/v1/account/invitations/{id}/retry", { params: { path: { id } } })),
    onSuccess: () => void refresh(),
  });

  const error = invite.error ?? remove.error ?? retry.error;
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
                <SelectTrigger id="invite-role" className="w-full sm:w-52" aria-describedby="invite-role-help">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["editor", "box_office", "finance", "event_manager", "owner"] as const).map((r) => (
                    <SelectItem key={r} value={r}>
                      <span className="grid">
                        <span>{roleLabel(r)}</span>
                        <span className="text-xs text-muted-foreground">{t(`members.roleHelp.${r}`)}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p id="invite-role-help" className="text-xs text-muted-foreground sm:max-w-52">{t(`members.roleHelp.${role}`)}</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-signin">{t("members.signin")}</Label>
              <Select value={signinKind} onValueChange={(v) => setSigninKind(v as SigninKind)}>
                <SelectTrigger id="invite-signin" className="w-full sm:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["auto", "work", "local"] as const).map((k) => <SelectItem key={k} value={k}>{t(`members.signinKinds.${k}`)}</SelectItem>)}
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
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {t("members.pending")} ·
                      <Badge variant={i.provisioning.status === "failed" ? "destructive" : "outline"} className="font-normal">
                        {t(`members.provisioning.${i.provisioning.status}`, { kind: i.provisioning.kind ? t(`members.signinKinds.${i.provisioning.kind}`) : "" })}
                      </Badge>
                      {i.provisioning.emailSent && <span>{t("members.emailSent")}</span>}
                    </div>
                    {i.provisioning.error && <div className="mt-1 max-w-md truncate text-xs text-destructive" title={i.provisioning.error}>{i.provisioning.error}</div>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{roleLabel(i.role)}</Badge>
                  </TableCell>
                  <TableCell>
                    {isOwner && (
                      <Button variant="ghost" size="icon" aria-label={`${t("members.retry")} ${i.email}`} onClick={() => retry.mutate(i.id)} disabled={retry.isPending}>
                        <RefreshCw />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
