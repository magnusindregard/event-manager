import { Box, List, ListItemButton, ListItemText, Paper, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { useApp } from "../AppContext.js";

export function AccountPicker() {
  const { t } = useTranslation();
  const { me, selectAccount } = useApp();
  const accounts = me?.accounts ?? [];
  return (
    <Box component="main" sx={{ minHeight: "100vh", display: "grid", placeItems: "center", p: 2 }}>
      <Paper sx={{ p: 3, width: "100%", maxWidth: 480 }}>
        <Typography variant="h5" component="h1" gutterBottom>{t("account.choose")}</Typography>
        {accounts.length === 0 ? (
          <Typography>{t("account.none")}</Typography>
        ) : (
          <List>
            {accounts.map((a) => (
              <ListItemButton key={a.accountId} onClick={() => selectAccount(a.accountId)}>
                <ListItemText primary={a.name} secondary={a.roles.map((r) => t(`members.roles.${r}`, r)).join(", ")} />
              </ListItemButton>
            ))}
          </List>
        )}
      </Paper>
    </Box>
  );
}
