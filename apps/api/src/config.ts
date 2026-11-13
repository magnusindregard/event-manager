export interface Config {
  port: number;
  databaseUrl: string;
  oidc: { issuer: string; audience: string } | null;
  devAuthSecret: string | null;
  corsOrigins: string[];
  production: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const oidc = env.OIDC_ISSUER && env.OIDC_AUDIENCE ? { issuer: env.OIDC_ISSUER, audience: env.OIDC_AUDIENCE } : null;
  const devAuthSecret = env.AUTH_DEV_SECRET || null;
  if (production && devAuthSecret) throw new Error("AUTH_DEV_SECRET must not be set in production");
  if (!oidc && !devAuthSecret) throw new Error("Configure OIDC_ISSUER + OIDC_AUDIENCE (or AUTH_DEV_SECRET locally)");
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl,
    oidc,
    devAuthSecret,
    corsOrigins: (env.CORS_ORIGINS ?? (production ? "" : "http://localhost:5173")).split(",").filter(Boolean),
    production,
  };
}
