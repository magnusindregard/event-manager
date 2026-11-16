import { parseArgs } from "node:util";
import { createDb } from "@event-manager/db";
import { tenancy } from "@event-manager/domain";

// Bootstrap an account and invite its first owner. Runs as a Container Apps Job in Azure:
//   create-account --slug munch --name MUNCH --owner-email someone@munch.no
const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    name: { type: "string" },
    "owner-email": { type: "string" },
    timezone: { type: "string" },
    locales: { type: "string" },
  },
});
if (!values.slug || !values.name || !values["owner-email"]) {
  console.error("Usage: create-account --slug <slug> --name <name> --owner-email <email> [--timezone Europe/Oslo] [--locales nb,en]");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url, { max: 1 });
try {
  const account = await tenancy.createAccount(db, {
    slug: values.slug,
    name: values.name,
    ownerEmail: values["owner-email"],
    defaultTimezone: values.timezone,
    locales: values.locales?.split(","),
  });
  console.log(JSON.stringify({ accountId: account.id, slug: account.slug, invited: values["owner-email"] }));
} finally {
  await db.destroy();
}
