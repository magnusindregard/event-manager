import pg from "pg";

// Azure Database for PostgreSQL with Entra authentication (ADR 0014): the password is a
// short-lived token for the managed identity, fetched per new connection. Enabled with
// DATABASE_AUTH=entra; the user in DATABASE_URL is the identity's Postgres principal name.
const ENTRA_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

// timestamp (without time zone) holds floating local wall time (series slots). node-pg would
// read it in the process's timezone; keep it as an ISO string "YYYY-MM-DDTHH:mm:ss" instead.
const TIMESTAMP = 1114;
const TIMESTAMP_ARRAY = 1115;
const TEXT_ARRAY = 1009;
// date (rule date ranges) stays "YYYY-MM-DD"; node-pg would make it local midnight.
const DATE = 1082;
const localIso = (s: string) => s.replace(" ", "T").replace(/\.\d+$/, "");
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === TIMESTAMP) return localIso;
    if (oid === DATE) return (s: string) => s;
    if (oid === TIMESTAMP_ARRAY) {
      const parseArray = pg.types.getTypeParser(TEXT_ARRAY as never) as (s: string) => string[];
      return (s: string) => parseArray(s).map(localIso);
    }
    return pg.types.getTypeParser(oid as never, format as "text");
  },
} as pg.CustomTypesConfig;

export function poolConfig(connectionString: string, max: number): pg.PoolConfig {
  if (process.env.DATABASE_AUTH !== "entra") return { connectionString, max, types };
  let credential: { getToken(scope: string): Promise<{ token: string } | null> } | undefined;
  // No connectionString here: node-postgres lets its parsed fields override the config, and a URL
  // without a password parses to password "", which would replace the token callback below.
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    database: decodeURIComponent(url.pathname.slice(1)),
    max,
    types,
    ssl: { rejectUnauthorized: true },
    password: async () => {
      if (!credential) {
        const { DefaultAzureCredential } = await import("@azure/identity");
        credential = new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID });
      }
      const token = await credential.getToken(ENTRA_SCOPE);
      if (!token) throw new Error("Could not get an Entra token for PostgreSQL");
      return token.token;
    },
  };
}
