import { Alert, Box, Button, Paper, Stack, TextField, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthProvider.js";

export function SignIn() {
  const { t } = useTranslation();
  const auth = useAuth();
  const dev = import.meta.env.VITE_AUTH_MODE === "dev";
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <Box component="main" sx={{ minHeight: "100vh", display: "grid", placeItems: "center", p: 2, bgcolor: "background.default" }}>
      <Paper sx={{ p: 4, width: "100%", maxWidth: 400 }}>
        <Stack
          component="form"
          spacing={2}
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            // Misconfiguration (wrong authority, unknown tenant) surfaces here instead of a dead button.
            auth.signIn(dev ? email : undefined).catch((err: unknown) => {
              console.error(err);
              setError(err instanceof Error ? err.message : String(err));
            });
          }}
        >
          <Typography variant="h5" component="h1">{t("app.title")}</Typography>
          {error && (
            <Alert severity="error">
              {t("auth.failed")}
              <Typography variant="body2" component="div" sx={{ mt: 1, wordBreak: "break-word" }}>{error}</Typography>
            </Alert>
          )}
          {dev && (
            <TextField label={t("auth.devEmail")} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          )}
          <Button type="submit" variant="contained">{t("auth.signIn")}</Button>
        </Stack>
      </Paper>
    </Box>
  );
}
