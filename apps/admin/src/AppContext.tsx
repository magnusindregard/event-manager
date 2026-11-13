import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { type Api, createApi, type Me, setCurrentAccountId, unwrap } from "./api.js";
import { useAuth } from "./auth/AuthProvider.js";

interface AppState {
  api: Api;
  me: Me | undefined;
  meLoading: boolean;
  accountId: string | null;
  roles: string[];
  selectAccount(id: string | null): void;
}

const Ctx = createContext<AppState | null>(null);
const ACCOUNT_KEY = "em.accountId";

export function AppProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const api = useMemo(() => createApi(auth), [auth]);
  const [accountId, setAccountId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACCOUNT_KEY);
    } catch {
      return null;
    }
  });

  const meQuery = useQuery({
    queryKey: ["me", auth.user?.email],
    enabled: !!auth.user,
    queryFn: async () => unwrap(await api.GET("/v1/me")),
  });

  const me = meQuery.data;
  // Fall back to the only account, and drop a remembered account the user lost access to.
  const effective =
    me && accountId && me.accounts.some((a) => a.accountId === accountId)
      ? accountId
      : me?.accounts.length === 1
        ? me.accounts[0]!.accountId
        : null;
  setCurrentAccountId(effective);
  const roles = me?.accounts.find((a) => a.accountId === effective)?.roles ?? [];

  const selectAccount = (id: string | null) => {
    setAccountId(id);
    try {
      if (id) localStorage.setItem(ACCOUNT_KEY, id);
      else localStorage.removeItem(ACCOUNT_KEY);
    } catch {
      /* ignore */
    }
  };

  return (
    <Ctx.Provider value={{ api, me, meLoading: meQuery.isLoading, accountId: effective, roles, selectAccount }}>
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}
