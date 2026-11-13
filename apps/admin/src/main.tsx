import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { enUS as coreEn, nbNO as coreNb } from "@mui/material/locale";
import { enUS as gridEn, nbNO as gridNb } from "@mui/x-data-grid/locales";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import "./i18n.js";
import { AppProvider, useApp } from "./AppContext.js";
import { AuthProvider, useAuth } from "./auth/AuthProvider.js";
import { Layout } from "./components/Layout.js";
import { AccountPicker } from "./pages/AccountPicker.js";
import { Audit } from "./pages/Audit.js";
import { ComingSoon } from "./pages/ComingSoon.js";
import { Members } from "./pages/Members.js";
import { Settings } from "./pages/Settings.js";
import { SignIn } from "./pages/SignIn.js";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function Themed({ children }: { children: React.ReactNode }) {
  const { i18n } = useTranslation();
  const theme = useMemo(() => {
    const nb = i18n.language === "nb";
    return createTheme({ cssVariables: true, colorSchemes: { light: true, dark: true } }, nb ? coreNb : coreEn, nb ? gridNb : gridEn);
  }, [i18n.language]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}

function Shell() {
  const auth = useAuth();
  if (!auth.user) return <SignIn />;
  return (
    <AppProvider>
      <Routed />
    </AppProvider>
  );
}

function Routed() {
  const { me, meLoading, accountId } = useApp();
  if (meLoading || !me) return null;
  if (!accountId) return <AccountPicker />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/settings" replace />} />
        <Route path="events" element={<ComingSoon titleKey="nav.events" milestone={2} />} />
        <Route path="locations" element={<ComingSoon titleKey="nav.locations" milestone={2} />} />
        <Route path="settings" element={<Settings />} />
        <Route path="members" element={<Members />} />
        <Route path="audit" element={<Audit />} />
        <Route path="*" element={<Navigate to="/settings" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Themed>
        <BrowserRouter>
          <AuthProvider>
            <Shell />
          </AuthProvider>
        </BrowserRouter>
      </Themed>
    </QueryClientProvider>
  </StrictMode>,
);
