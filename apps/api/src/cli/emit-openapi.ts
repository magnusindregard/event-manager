import { writeFile } from "node:fs/promises";
import { createDb } from "@event-manager/db";
import { buildApp } from "../app.js";

// Writes the OpenAPI document without a database or IdP. CI diffs it against main (oasdiff).
const out = process.argv[2] ?? "openapi.json";
// pg pools connect lazily, so this never touches a database.
const db = createDb("postgres://unused@127.0.0.1:1/none");
const app = await buildApp({ db, verifier: { verify: async () => { throw new Error("unused"); } } });
await app.ready();
await writeFile(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
console.log(`wrote ${out}`);
await app.close();
await db.destroy();
