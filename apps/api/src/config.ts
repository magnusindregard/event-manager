export interface Config {
  port: number;
  databaseUrl: string;
  oidc: { issuer: string; audience: string } | null;
  devAuthSecret: string | null;
  corsOrigins: string[];
  production: boolean;
  attendeeUrl: string;
  postmarkWebhook: { user: string; password: string } | null;
  mcp: { authorizationServers: string[]; scopes: string[]; publicUrl?: string; adminUrl?: string };
  /** Our HubSpot app (docs/hubspot.md). redirectUrl is the admin's callback page, registered in the app. */
  hubspot: { clientId: string; clientSecret: string; redirectUrl: string; fake: boolean } | null;
  /** VIPPS=http calls Vipps; fake (the default outside production) uses an in-memory Vipps; off leaves payments off. */
  vipps: "http" | "fake" | "off";
  /** The API's public base URL, for webhooks from Vipps. */
  publicUrl: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const oidc = env.OIDC_ISSUER && env.OIDC_AUDIENCE ? { issuer: env.OIDC_ISSUER, audience: env.OIDC_AUDIENCE } : null;
  const devAuthSecret = env.AUTH_DEV_SECRET || null;
  if (production && devAuthSecret) throw new Error("AUTH_DEV_SECRET must not be set in production");
  if (!oidc && !devAuthSecret) throw new Error("Configure OIDC_ISSUER + OIDC_AUDIENCE (or AUTH_DEV_SECRET locally)");
  const publicUrl = env.PUBLIC_URL || undefined;
  // Links to events in the admin in MCP tool results; none in production unless set.
  const adminUrl = env.ADMIN_URL || (production ? undefined : "http://localhost:5173/");
  // HUBSPOT_CLIENT_ID + HUBSPOT_CLIENT_SECRET (Key Vault); HUBSPOT_REDIRECT_URL defaults to the admin's page.
  // HUBSPOT=fake (local only): a fake portal that approves installs at once.
  const hubspotFake = env.HUBSPOT === "fake";
  if (hubspotFake && production) throw new Error("HUBSPOT=fake must not be set in production");
  const hubspotRedirect = env.HUBSPOT_REDIRECT_URL || (adminUrl ? new URL("integrations/hubspot/callback", adminUrl).toString() : undefined);
  if (env.HUBSPOT_CLIENT_ID && !env.HUBSPOT_CLIENT_SECRET) throw new Error("HUBSPOT_CLIENT_SECRET is required with HUBSPOT_CLIENT_ID");
  if ((env.HUBSPOT_CLIENT_ID || hubspotFake) && !hubspotRedirect) throw new Error("Set HUBSPOT_REDIRECT_URL or ADMIN_URL with HUBSPOT_CLIENT_ID");
  const vipps = env.VIPPS === "http" || env.VIPPS === "fake" || env.VIPPS === "off" ? env.VIPPS : production ? "off" : "fake";
  if (production && vipps === "fake") throw new Error("VIPPS=fake must not be used in production");
  return {
    vipps,
    publicUrl: publicUrl ?? null,
    port: Number(env.PORT ?? 3000),
    databaseUrl,
    oidc,
    devAuthSecret,
    corsOrigins: (env.CORS_ORIGINS ?? (production ? "" : "http://localhost:5173")).split(",").filter(Boolean),
    production,
    attendeeUrl: env.ATTENDEE_URL ?? "http://localhost:3020",
    // POSTMARK_WEBHOOK_AUTH=user:password, the same as in the webhook URL configured in Postmark.
    postmarkWebhook: env.POSTMARK_WEBHOOK_AUTH?.includes(":")
      ? { user: env.POSTMARK_WEBHOOK_AUTH.slice(0, env.POSTMARK_WEBHOOK_AUTH.indexOf(":")), password: env.POSTMARK_WEBHOOK_AUTH.slice(env.POSTMARK_WEBHOOK_AUTH.indexOf(":") + 1) }
      : null,
    // MCP clients sign in at the staff IdP (docs/mcp.md). MCP_OAUTH_SCOPES: the API scope, e.g. api://em-api/access.
    mcp: {
      authorizationServers: oidc ? [oidc.issuer] : [],
      scopes: (env.MCP_OAUTH_SCOPES ?? "").split(/[\s,]+/).filter(Boolean),
      ...(publicUrl ? { publicUrl } : {}),
      ...(adminUrl ? { adminUrl } : {}),
    },
    hubspot: hubspotFake
      ? { clientId: "fake", clientSecret: "local-fake-hubspot", redirectUrl: hubspotRedirect!, fake: true }
      : env.HUBSPOT_CLIENT_ID
        ? { clientId: env.HUBSPOT_CLIENT_ID, clientSecret: env.HUBSPOT_CLIENT_SECRET!, redirectUrl: hubspotRedirect!, fake: false }
        : null,
  };
}
