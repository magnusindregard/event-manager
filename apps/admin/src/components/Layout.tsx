import {
  AppBar, Box, Button, Drawer, IconButton, List, ListItemButton, ListItemIcon, ListItemText,
  MenuItem, Select, Toolbar, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import EventIcon from "@mui/icons-material/Event";
import PlaceIcon from "@mui/icons-material/Place";
import SettingsIcon from "@mui/icons-material/Settings";
import PeopleIcon from "@mui/icons-material/People";
import HistoryIcon from "@mui/icons-material/History";
import MenuIcon from "@mui/icons-material/Menu";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router";
import { useApp } from "../AppContext.js";
import { useAuth } from "../auth/AuthProvider.js";

const WIDTH = 240;

export function Layout() {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const { me, accountId, selectAccount } = useApp();
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up("md"));
  const [open, setOpen] = useState(false);
  const account = me?.accounts.find((a) => a.accountId === accountId);

  const nav = [
    { to: "/events", label: t("nav.events"), icon: <EventIcon /> },
    { to: "/locations", label: t("nav.locations"), icon: <PlaceIcon /> },
    { to: "/settings", label: t("nav.settings"), icon: <SettingsIcon /> },
    { to: "/members", label: t("nav.members"), icon: <PeopleIcon /> },
    { to: "/audit", label: t("nav.audit"), icon: <HistoryIcon /> },
  ];

  const drawer = (
    <List component="nav" aria-label={t("app.title")}>
      {nav.map((n) => (
        <ListItemButton key={n.to} component={NavLink} to={n.to} onClick={() => setOpen(false)} sx={{ "&.active": { bgcolor: "action.selected" } }}>
          <ListItemIcon>{n.icon}</ListItemIcon>
          <ListItemText primary={n.label} />
        </ListItemButton>
      ))}
    </List>
  );

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <AppBar position="fixed" sx={{ zIndex: (th) => th.zIndex.drawer + 1 }}>
        <Toolbar sx={{ gap: 1 }}>
          {!wide && (
            <IconButton color="inherit" edge="start" aria-label="menu" onClick={() => setOpen(true)}>
              <MenuIcon />
            </IconButton>
          )}
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }} noWrap>
            {account?.name ?? t("app.title")}
          </Typography>
          {(me?.accounts.length ?? 0) > 1 && (
            <Button color="inherit" onClick={() => selectAccount(null)}>{t("account.switch")}</Button>
          )}
          <Select
            size="small"
            value={i18n.language}
            onChange={(e) => {
              void i18n.changeLanguage(e.target.value);
              try { localStorage.setItem("em.lang", e.target.value); } catch { /* ignore */ }
            }}
            inputProps={{ "aria-label": "Language" }}
            sx={{ color: "inherit", ".MuiOutlinedInput-notchedOutline": { borderColor: "rgba(255,255,255,.4)" } }}
          >
            <MenuItem value="nb">Norsk</MenuItem>
            <MenuItem value="en">English</MenuItem>
          </Select>
          <Button color="inherit" onClick={() => void auth.signOut()} title={t("auth.signedInAs", { email: auth.user?.email })}>
            {t("auth.signOut")}
          </Button>
        </Toolbar>
      </AppBar>
      <Drawer
        variant={wide ? "permanent" : "temporary"}
        open={wide || open}
        onClose={() => setOpen(false)}
        sx={{ width: WIDTH, flexShrink: 0, "& .MuiDrawer-paper": { width: WIDTH, boxSizing: "border-box" } }}
      >
        <Toolbar />
        {drawer}
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, p: { xs: 2, md: 3 }, minWidth: 0 }}>
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
}
