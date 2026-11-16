import pg from "pg";

// Azure Database for PostgreSQL with Entra authentication (ADR 0014): the password is a
// short-lived token for the managed identity, fetched per new connection. Enabled with
// DATABASE_AUTH=entra; the user in DATABASE_URL is the identity's Postgres principal name.
const ENTRA_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

export function poolConfig(connectionString: string, max: number): pg.PoolConfig {
  if (process.env.DATABASE_AUTH !== "entra") return { connectionString, max };
  let credential: { getToken(scope: string): Promise<{ token: string } | null> } | undefined;
  return {
    connectionString,
    max,
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
