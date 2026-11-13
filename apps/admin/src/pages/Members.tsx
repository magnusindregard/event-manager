import { Alert, Button, Chip, IconButton, List, ListItem, ListItemText, MenuItem, Paper, Stack, TextField, Typography } from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { unwrap } from "../api.js";
import { useApp } from "../AppContext.js";

export function Members() {
  const { t } = useTranslation();
  const { api, accountId, roles, me } = useApp();
  const qc = useQueryClient();
  const isOwner = roles.includes("owner");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"owner" | "editor">("editor");

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

  return (
    <Stack spacing={3} sx={{ maxWidth: 720 }}>
      <Typography variant="h4" component="h1">{t("members.title")}</Typography>
      {(invite.error || remove.error) && <Alert severity="error">{(invite.error ?? remove.error)!.message}</Alert>}
      {isOwner && (
        <Stack
          component="form"
          direction={{ xs: "column", sm: "row" }}
          spacing={1}
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <TextField label={t("members.email")} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} sx={{ flex: 1 }} />
          <TextField select label={t("members.role")} value={role} onChange={(e) => setRole(e.target.value as "owner" | "editor")} sx={{ minWidth: 140 }}>
            <MenuItem value="editor">{t("members.roles.editor")}</MenuItem>
            <MenuItem value="owner">{t("members.roles.owner")}</MenuItem>
          </TextField>
          <Button type="submit" variant="contained" disabled={invite.isPending}>{t("members.invite")}</Button>
        </Stack>
      )}
      <Paper>
        <List>
          {query.data?.members.map((m) => (
            <ListItem
              key={m.userId}
              secondaryAction={
                isOwner && m.userId !== me?.userId ? (
                  <IconButton edge="end" aria-label={t("members.remove")} onClick={() => remove.mutate(m.userId)}>
                    <DeleteIcon />
                  </IconButton>
                ) : null
              }
            >
              <ListItemText primary={m.name ?? m.email} secondary={m.email} />
              <Stack direction="row" spacing={0.5} sx={{ mr: 4 }}>
                {m.roles.map((r) => <Chip key={r} size="small" label={t(`members.roles.${r}`, r)} />)}
              </Stack>
            </ListItem>
          ))}
          {query.data?.invitations.map((i) => (
            <ListItem key={i.id}>
              <ListItemText primary={i.email} secondary={t("members.pending")} />
              <Chip size="small" variant="outlined" label={t(`members.roles.${i.role}`, i.role)} />
            </ListItem>
          ))}
        </List>
      </Paper>
    </Stack>
  );
}
