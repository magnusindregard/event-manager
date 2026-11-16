import { writeFile } from "node:fs/promises";
import { createDb } from "@event-manager/db";
import { buildPublicApp } from "../app.js";

// Writes the public OpenAPI document without a database. CI diffs it against main (oasdiff).
const out = process.argv[2] ?? "openapi.json";
const db = createDb("postgres://unused@127.0.0.1:1/none");
const app = await buildPublicApp({ db });
await app.ready();
await writeFile(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
console.log(`wrote ${out}`);
await app.close();
await db.destroy();
