import { createContext, type ReactNode, useContext, useEffect, useMemo, useReducer, useState } from "react";
import { createDevAuth } from "./dev.js";
import type { Auth } from "./types.js";

// version changes on sign-in/out so consumers re-render; the Auth object itself is stable.
const AuthContext = createContext<{ auth: Auth; version: number } | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [version, rerender] = useReducer((n: number) => n + 1, 0);
  const [auth, setAuth] = useState<Auth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (import.meta.env.VITE_AUTH_MODE === "dev") {
      setAuth(createDevAuth(rerender));
      return;
    }
    import("./msal.js")
      .then((m) => m.createMsalAuth(rerender))
      .then(setAuth)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const value = useMemo(() => (auth ? { auth, version } : null), [auth, version]);
  if (error) return <pre role="alert">{error}</pre>;
  if (!value) return null;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx.auth;
}
