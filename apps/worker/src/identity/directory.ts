import { randomBytes } from "node:crypto";

/**
 * The staff identity provider's user directory (ADR 0012: Entra External ID via Microsoft Graph).
 * Production uses GraphDirectory; local development and tests use FakeDirectory.
 */
export interface IdentityDirectory {
  /** "work" if the address belongs to an Entra ID (or federated) organisation. */
  realm(email: string): Promise<"work" | "local">;
  findUserByEmail(email: string): Promise<{ id: string } | null>;
  /** B2B guest invitation. Returns the URL the guest redeems once. */
  inviteGuest(email: string, redirectUrl: string): Promise<{ id: string; redeemUrl: string }>;
  /** Local customer account with email sign-in (one-time passcode in the user flow). */
  createLocalUser(email: string): Promise<{ id: string }>;
}

export class DirectoryError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

/** Consumer mail domains that may look "Managed" in a realm lookup but are not organisations. */
const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "yahoo.com", "proton.me", "protonmail.com"]);

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  /** e.g. managetheevents.onmicrosoft.com, the issuer of local email identities. */
  tenantDomain: string;
  /** Local only. In Azure the managed identity's federated credential is used instead. */
  clientSecret?: string;
  /** Managed identity client ID (AZURE_CLIENT_ID) for the federated credential. */
  managedIdentityClientId?: string;
}

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Microsoft Graph with app-only permissions User.Invite.All and User.ReadWrite.All. */
export class GraphDirectory implements IdentityDirectory {
  private token: { value: string; until: number } | undefined;

  constructor(private readonly cfg: GraphConfig) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 60_000) return this.token.value;
    const { ClientSecretCredential, ClientAssertionCredential, ManagedIdentityCredential } = await import("@azure/identity");
    const credential = this.cfg.clientSecret
      ? new ClientSecretCredential(this.cfg.tenantId, this.cfg.clientId, this.cfg.clientSecret)
      : (() => {
          // Workload identity federation: the app's managed identity signs an assertion that the
          // external tenant's app registration trusts. No client secret exists (ADR 0012).
          const mi = new ManagedIdentityCredential({ clientId: this.cfg.managedIdentityClientId });
          return new ClientAssertionCredential(this.cfg.tenantId, this.cfg.clientId, async () => {
            const t = await mi.getToken("api://AzureADTokenExchange/.default");
            if (!t) throw new Error("No managed identity token");
            return t.token;
          });
        })();
    const t = await credential.getToken("https://graph.microsoft.com/.default");
    if (!t) throw new DirectoryError("No Graph token", true);
    this.token = { value: t.token, until: t.expiresOnTimestamp };
    return t.token;
  }

  private async graph<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${GRAPH}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json", ConsistencyLevel: "eventual" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new DirectoryError(`Graph ${method} ${path.split("?")[0]} → ${res.status}: ${text.slice(0, 300)}`, res.status === 429 || res.status >= 500);
    }
    return (await res.json()) as T;
  }

  async realm(email: string): Promise<"work" | "local"> {
    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    if (CONSUMER_DOMAINS.has(domain)) return "local";
    const res = await fetch(`https://login.microsoftonline.com/common/userrealm/${encodeURIComponent(email)}?api-version=2.1`);
    if (!res.ok) throw new DirectoryError(`Realm lookup failed: ${res.status}`, true);
    const info = (await res.json()) as { NameSpaceType?: string };
    return info.NameSpaceType === "Managed" || info.NameSpaceType === "Federated" ? "work" : "local";
  }

  async findUserByEmail(email: string): Promise<{ id: string } | null> {
    const q = email.replace(/'/g, "''");
    const byMail = await this.graph<{ value: { id: string }[] }>("GET", `/users?$select=id&$filter=${encodeURIComponent(`mail eq '${q}' or otherMails/any(m:m eq '${q}')`)}&$count=true`);
    if (byMail.value[0]) return byMail.value[0];
    const byIdentity = await this.graph<{ value: { id: string }[] }>(
      "GET",
      `/users?$select=id&$filter=${encodeURIComponent(`identities/any(i:i/issuerAssignedId eq '${q}' and i/issuer eq '${this.cfg.tenantDomain}')`)}`,
    );
    return byIdentity.value[0] ?? null;
  }

  async inviteGuest(email: string, redirectUrl: string): Promise<{ id: string; redeemUrl: string }> {
    // We send our own email with the redeem link, so the guest gets one message, not two.
    const res = await this.graph<{ invitedUser: { id: string }; inviteRedeemUrl: string }>("POST", "/invitations", {
      invitedUserEmailAddress: email,
      inviteRedirectUrl: redirectUrl,
      sendInvitationMessage: false,
    });
    return { id: res.invitedUser.id, redeemUrl: res.inviteRedeemUrl };
  }

  async createLocalUser(email: string): Promise<{ id: string }> {
    // Sign-in uses one-time passcodes; Graph still requires a password, which nobody ever sees.
    const res = await this.graph<{ id: string }>("POST", "/users", {
      accountEnabled: true,
      displayName: email.split("@")[0],
      mail: email,
      identities: [{ signInType: "emailAddress", issuer: this.cfg.tenantDomain, issuerAssignedId: email }],
      passwordProfile: { password: `${randomBytes(24).toString("base64url")}aA1!`, forceChangePasswordNextSignIn: false },
      passwordPolicies: "DisablePasswordExpiration",
    });
    return { id: res.id };
  }
}

/** In-memory directory for local development and tests. */
export class FakeDirectory implements IdentityDirectory {
  readonly users = new Map<string, { id: string; kind: "work" | "local" }>();
  /** Calls to fail before succeeding, to exercise retries. */
  failNext = 0;
  workDomains = new Set(["work.test", "knowit.no"]);
  readonly calls: string[] = [];

  private maybeFail(op: string) {
    this.calls.push(op);
    if (this.failNext > 0) {
      this.failNext--;
      throw new DirectoryError(`fake ${op} failure`, true);
    }
  }

  async realm(email: string) {
    this.maybeFail("realm");
    return this.workDomains.has(email.split("@")[1] ?? "") ? ("work" as const) : ("local" as const);
  }
  async findUserByEmail(email: string) {
    this.maybeFail("find");
    const u = this.users.get(email);
    return u ? { id: u.id } : null;
  }
  async inviteGuest(email: string, redirectUrl: string) {
    this.maybeFail("inviteGuest");
    const id = `guest-${this.users.size + 1}`;
    this.users.set(email, { id, kind: "work" });
    return { id, redeemUrl: `https://login.example/redeem?user=${id}&redirect=${encodeURIComponent(redirectUrl)}` };
  }
  async createLocalUser(email: string) {
    this.maybeFail("createLocalUser");
    const id = `local-${this.users.size + 1}`;
    this.users.set(email, { id, kind: "local" });
    return { id };
  }
}
