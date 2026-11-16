import { InteractionRequiredAuthError, LogLevel, PublicClientApplication } from "@azure/msal-browser";
import type { Auth } from "./types.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * External ID authorities must name the tenant by ID: https://<prefix>.ciamlogin.com/<tenant-id>/.
 * The tenant's issuer is https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0, and MSAL only accepts
 * it when the authority path carries that same ID. A bare host or <prefix>.onmicrosoft.com fails
 * MSAL's issuer check with a generic endpoints_resolution_error, so fail early with a clear message.
 */
export function ciamAuthority(configured: string): string {
  const url = new URL(configured);
  if (!url.hostname.endsWith(".ciamlogin.com")) return configured;
  const [tenant] = url.pathname.split("/").filter(Boolean);
  if (!tenant || !GUID.test(tenant)) {
    throw new Error(`VITE_ENTRA_AUTHORITY must be https://${url.hostname}/<external tenant ID>/`);
  }
  return `${url.origin}/${tenant}/`;
}

// Entra External ID (ADR 0012). Authorization code + PKCE; tokens kept in sessionStorage.
export async function createMsalAuth(onChange: () => void): Promise<Auth> {
  const scope = import.meta.env.VITE_ENTRA_API_SCOPE as string;
  const configured = import.meta.env.VITE_ENTRA_AUTHORITY as string;
  const clientId = import.meta.env.VITE_ENTRA_CLIENT_ID as string;
  if (!configured || !clientId || !scope) {
    throw new Error("Set VITE_ENTRA_AUTHORITY, VITE_ENTRA_CLIENT_ID and VITE_ENTRA_API_SCOPE, or VITE_AUTH_MODE=dev");
  }
  const authority = ciamAuthority(configured);
  const pca = new PublicClientApplication({
    auth: {
      clientId,
      authority,
      // External ID authorities (<prefix>.ciamlogin.com) must be listed as known.
      knownAuthorities: [new URL(authority).host],
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: "sessionStorage" },
    // MSAL wraps discovery failures in a generic error; its log has the cause.
    system: {
      loggerOptions: {
        logLevel: import.meta.env.DEV ? LogLevel.Info : LogLevel.Warning,
        piiLoggingEnabled: false,
        loggerCallback: (level, message, containsPii) => {
          if (containsPii) return;
          if (level === LogLevel.Error) console.error(`[msal] ${message}`);
          else if (level === LogLevel.Warning) console.warn(`[msal] ${message}`);
          else console.info(`[msal] ${message}`);
        },
      },
    },
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
