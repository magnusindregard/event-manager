import { InteractionRequiredAuthError, PublicClientApplication } from "@azure/msal-browser";
import type { Auth } from "./types.js";

// Entra External ID (ADR 0012). Authorization code + PKCE; tokens kept in sessionStorage.
export async function createMsalAuth(onChange: () => void): Promise<Auth> {
  const scope = import.meta.env.VITE_ENTRA_API_SCOPE as string;
  const pca = new PublicClientApplication({
    auth: {
      clientId: import.meta.env.VITE_ENTRA_CLIENT_ID as string,
      authority: import.meta.env.VITE_ENTRA_AUTHORITY as string,
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: "sessionStorage" },
  });
  await pca.initialize();
  const result = await pca.handleRedirectPromise();
  if (result?.account) pca.setActiveAccount(result.account);
  if (!pca.getActiveAccount()) {
    const [first] = pca.getAllAccounts();
    if (first) pca.setActiveAccount(first);
  }

  const current = () => {
    const a = pca.getActiveAccount();
    if (!a) return null;
    const email = (a.idTokenClaims?.email as string | undefined) ?? a.username;
    return { email, name: a.name ?? null };
  };

  return {
    ready: true,
    get user() {
      return current();
    },
    async signIn(loginHint) {
      await pca.loginRedirect({ scopes: [scope], ...(loginHint ? { loginHint } : {}) });
    },
    async signOut() {
      await pca.logoutRedirect();
      onChange();
    },
    async getToken() {
      const account = pca.getActiveAccount();
      if (!account) throw new Error("not signed in");
      try {
        const r = await pca.acquireTokenSilent({ scopes: [scope], account });
        return r.accessToken;
      } catch (e) {
        if (e instanceof InteractionRequiredAuthError) {
          await pca.acquireTokenRedirect({ scopes: [scope], account });
        }
        throw e;
      }
    },
  };
}
