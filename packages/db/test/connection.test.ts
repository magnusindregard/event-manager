import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { poolConfig } from "../src/connection.js";

// Entra auth (ADR 0014) runs only in Azure, so this checks the config node-postgres actually
// uses: the token callback must survive as the password.
afterEach(() => {
  delete process.env.DATABASE_AUTH;
});

it("keeps the Entra token callback as the password", () => {
  process.env.DATABASE_AUTH = "entra";
  const cfg = poolConfig("postgres://id-em-staging-migrator@psql-em-staging.private.postgres.database.azure.com:5432/event_manager", 1);
  const client = new pg.Client(cfg);
  expect(typeof (client as unknown as { password: unknown }).password).toBe("function");
  expect(client).toMatchObject({ user: "id-em-staging-migrator", host: "psql-em-staging.private.postgres.database.azure.com", port: 5432, database: "event_manager" });
  expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
});

it("would lose the callback if the URL were passed as connectionString (the bug this guards)", () => {
  const client = new pg.Client({ connectionString: "postgres://someone@host:5432/db", password: async () => "token" });
  expect(typeof (client as unknown as { password: unknown }).password).not.toBe("function");
});
