import {
  Alert, Autocomplete, Button, Chip, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle,
  MenuItem, Snackbar, Stack, TextField, Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type Account, ApiProblem, unwrap } from "../api.js";
import { useApp } from "../AppContext.js";

const TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["Europe/Oslo", "UTC"];
  }
})();
const LOCALE_OPTIONS = ["nb", "nn", "en", "se", "sv", "da", "de", "fr"];

type Form = Pick<Account, "name" | "defaultTimezone" | "defaultLocale" | "locales" | "horizonMonths">;

export function Settings() {
  const { t } = useTranslation();
  const { api, accountId, roles } = useApp();
  const qc = useQueryClient();
  const canEdit = roles.includes("owner");
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);

  const query = useQuery({
    queryKey: ["account", accountId],
    queryFn: async () => {
      const r = await api.GET("/v1/account");
      return { account: unwrap(r), etag: r.response.headers.get("etag") ?? "" };
    },
  });

  useEffect(() => {
    if (query.data) {
      const { name, defaultTimezone, defaultLocale, locales, horizonMonths } = query.data.account;
      setForm({ name, defaultTimezone, defaultLocale, locales, horizonMonths });
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
      setSaved(true);
    },
    onError: (e) => {
      if (e instanceof ApiProblem && e.code === "version_conflict") setConflict(true);
    },
  });

  if (query.isError) return <Alert severity="error">{t("error.generic")}</Alert>;
  if (!form) return null;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const otherError = save.error && !(save.error instanceof ApiProblem && save.error.code === "version_conflict");

  return (
    <Stack spacing={3} sx={{ maxWidth: 560 }}>
      <Typography variant="h4" component="h1">{t("settings.title")}</Typography>
      {!canEdit && <Alert severity="info">{t("settings.ownerOnly")}</Alert>}
      {otherError && <Alert severity="error">{save.error.message}</Alert>}
      <Stack
        component="form"
        spacing={2}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(form);
        }}
      >
        <TextField label={t("settings.name")} value={form.name} onChange={(e) => set("name", e.target.value)} required disabled={!canEdit} />
        <Autocomplete
          options={TIMEZONES}
          value={form.defaultTimezone}
          onChange={(_, v) => v && set("defaultTimezone", v)}
          disabled={!canEdit}
          disableClearable
          renderInput={(p) => <TextField {...p} label={t("settings.timezone")} />}
        />
        <Autocomplete
          multiple
          options={LOCALE_OPTIONS}
          value={form.locales}
          onChange={(_, v) => set("locales", v)}
          disabled={!canEdit}
          renderValue={(value, getItemProps) =>
            value.map((option, index) => <Chip label={option} {...getItemProps({ index })} key={option} />)
          }
          renderInput={(p) => <TextField {...p} label={t("settings.locales")} />}
        />
        <TextField select label={t("settings.defaultLocale")} value={form.defaultLocale} onChange={(e) => set("defaultLocale", e.target.value)} disabled={!canEdit}>
          {form.locales.map((l) => <MenuItem key={l} value={l}>{l}</MenuItem>)}
        </TextField>
        <TextField
          type="number"
          label={t("settings.horizon")}
          value={form.horizonMonths}
          onChange={(e) => set("horizonMonths", Number(e.target.value))}
          slotProps={{ htmlInput: { min: 1, max: 60 } }}
          disabled={!canEdit}
        />
        {canEdit && (
          <Button type="submit" variant="contained" disabled={save.isPending} sx={{ alignSelf: "flex-start" }}>
            {t("settings.save")}
          </Button>
        )}
      </Stack>

      <Snackbar open={saved} autoHideDuration={3000} onClose={() => setSaved(false)} message={t("settings.saved")} />
      <Dialog open={conflict} onClose={() => setConflict(false)}>
        <DialogTitle>{t("conflict.title")}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t("conflict.body")}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConflict(false)}>{t("conflict.cancel")}</Button>
          <Button
            variant="contained"
            onClick={() => {
              setConflict(false);
              void query.refetch();
            }}
          >
            {t("conflict.reload")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
