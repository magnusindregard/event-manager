// The HubSpot spike (docs/hubspot.md, milestone 0) against a developer test portal:
//
//   pnpm --filter @event-manager/worker hubspot-spike --portal <id> --email <your inbox> \
//     [--account <account id> | HUBSPOT_ACCESS_TOKEN=…] [--template-email <id>] [--send] [--keep] [--out <dir>]
//
// The token comes from a connected account (--account: DATABASE_URL, SENSITIVE_DATA_KEYS and
// HUBSPOT_CLIENT_ID/SECRET, refreshed like the worker does), or from HUBSPOT_ACCESS_TOKEN.
// Writes summary.md and one recording per step to --out (default spike-output/hubspot-<time>).
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "@event-manager/db";
import { HttpHubSpot } from "@event-manager/hubspot";
import { runSpike, summarise } from "../hubspot/spike.js";
import { withHubSpot } from "../hubspot/session.js";

const { values } = parseArgs({
  options: {
    portal: { type: "string" },
    email: { type: "string" },
    account: { type: "string" },
    "template-email": { type: "string" },
    "attendee-url": { type: "string" },
    send: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    out: { type: "string" },
  },
});
if (!values.portal || !values.email) {
  console.error("Usage: hubspot-spike --portal <id> --email <address> [--account <id>] [--template-email <id>] [--send] [--keep] [--out <dir>]");
  process.exit(2);
}

async function accessToken(): Promise<string> {
  if (!values.account) {
    const t = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!t) throw new Error("Pass --account <id> (with DATABASE_URL) or set HUBSPOT_ACCESS_TOKEN");
    return t;
  }
  const { DATABASE_URL, HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET } = process.env;
  if (!DATABASE_URL || !HUBSPOT_CLIENT_ID || !HUBSPOT_CLIENT_SECRET) throw new Error("--account needs DATABASE_URL, HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET");
  const db = createDb(DATABASE_URL, { max: 1 });
  try {
    const client = new HttpHubSpot({ clientId: HUBSPOT_CLIENT_ID, clientSecret: HUBSPOT_CLIENT_SECRET, redirectUrl: "" });
    const r = await withHubSpot(db, values.account, client, async (token) => token);
    if (!r) throw new Error(`Account ${values.account} has no active HubSpot connection`);
    return r.value;
  } finally {
    await db.destroy();
  }
}

const now = new Date();
const base = process.env.INIT_CWD ?? process.cwd();
const out = values.out ? (isAbsolute(values.out) ? values.out : resolve(base, values.out)) : join(base, "spike-output", `hubspot-${now.toISOString().replace(/[:.]/g, "-")}`);

const { results, recordings } = await runSpike(
  {
    portalId: values.portal,
    email: values.email,
    templateEmailId: values["template-email"],
    send: values.send,
    keep: values.keep,
    attendeeUrl: values["attendee-url"] ?? process.env.ATTENDEE_URL ?? "https://attendee.example",
    now,
  },
  { accessToken: await accessToken(), fetch, log: (l) => console.log(l) },
);

await mkdir(join(out, "recordings"), { recursive: true });
const summary = summarise(results, values.portal, now);
await writeFile(join(out, "summary.md"), summary);
for (const id of new Set(recordings.map((r) => r.step))) {
  await writeFile(join(out, "recordings", `${id}.json`), JSON.stringify(recordings.filter((r) => r.step === id), null, 2) + "\n");
}
console.log(`\n${summary}\nWritten to ${out}`);
process.exitCode = results.some((r) => r.outcome === "fail") ? 1 : 0;
