import { Box, Button, Paper, Stack, TextField, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthProvider.js";

export function SignIn() {
  const { t } = useTranslation();
  const auth = useAuth();
  const dev = import.meta.env.VITE_AUTH_MODE === "dev";
  const [email, setEmail] = useState("");

  return (
    <Box component="main" sx={{ minHeight: "100vh", display: "grid", placeItems: "center", p: 2, bgcolor: "background.default" }}>
      <Paper sx={{ p: 4, width: "100%", maxWidth: 400 }}>
        <Stack
          component="form"
          spacing={2}
          onSubmit={(e) => {
            e.preventDefault();
            void auth.signIn(dev ? email : undefined);
          }}
        >
          <Typography variant="h5" component="h1">{t("app.title")}</Typography>
          {dev && (
            <TextField label={t("auth.devEmail")} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          )}
          <Button type="submit" variant="contained">{t("auth.signIn")}</Button>
        </Stack>
      </Paper>
    </Box>
  );
}
