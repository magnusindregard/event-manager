import { InteractionRequiredAuthError, PublicClientApplication } from "@azure/msal-browser";
import type { Auth } from "./types.js";

// Entra External ID (ADR 0012). Authorization code + PKCE; tokens kept in sessionStorage.
export async function createMsalAuth(onChange: () => void): Promise<Auth> {
  const scope = import.meta.env.VITE_ENTRA_API_SCOPE as string;
  const authority = import.meta.env.VITE_ENTRA_AUTHORITY as string;
  const clientId = import.meta.env.VITE_ENTRA_CLIENT_ID as string;
  if (!authority || !clientId || !scope) {
    throw new Error("Set VITE_ENTRA_AUTHORITY, VITE_ENTRA_CLIENT_ID and VITE_ENTRA_API_SCOPE, or VITE_AUTH_MODE=dev");
  }
  const pca = new PublicClientApplication({
    auth: {
      clientId,
      authority,
      // External ID authorities (<prefix>.ciamlogin.com) must be listed as known.
      knownAuthorities: [new URL(authority).host],
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
