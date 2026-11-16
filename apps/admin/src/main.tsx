import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import "./index.css";
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

// Dark mode follows the OS for now; shadcn's tokens switch on the .dark class.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyScheme();
dark.addEventListener("change", applyScheme);

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
      <BrowserRouter>
        <AuthProvider>
          <Shell />
        </AuthProvider>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
