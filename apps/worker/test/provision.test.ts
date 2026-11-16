import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, tenancy } from "@event-manager/domain";
import { defaultHandlers } from "../src/handlers.js";
import { FakeDirectory } from "../src/identity/directory.js";
import { FakeMailer } from "../src/identity/mailer.js";
import { buildTaskList } from "../src/tasks.js";

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let directory: FakeDirectory;
let mailer: FakeMailer;

/** Runs every job that is due, including jobs those jobs enqueue, like a worker would. */
async function drain() {
  for (let i = 0; i < 5; i++) {
    await admin.query(`update graphile_worker._private_jobs set run_at = now() where locked_at is null`);
    await runOnce({ connectionString: tdb.appUrl, taskList: buildTaskList(db, defaultHandlers, { directory, mailer, adminUrl: "https://admin.test/" }) });
  }
}

const invitation = (email: string) =>
  withTenant(db, ctx, async (tx) => (await tenancy.listInvitations(tx)).find((i) => i.email === email)!);

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.migratorUrl });
  await admin.connect();
  const account = await tenancy.createAccount(db, { slug: "prov", name: "MUNCH", ownerEmail: "owner@munch.test" });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "owner@munch.test", name: "Olga Owner" });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
beforeEach(() => {
  directory = new FakeDirectory();
  mailer = new FakeMailer();
});
afterAll(async () => {
  await db?.destroy();
  await admin?.end();
  await tdb?.stop();
});

describe("invitation provisioning", () => {
  it("creates a local one-time-passcode account for a non-work address and emails the invitee", async () => {
    await withTenant(db, ctx, (tx) => tenancy.inviteMember(tx, ctx, "anna@example.com", "editor"));
    await drain();
    const inv = await invitation("anna@example.com");
    expect(inv.provisioning).toMatchObject({ status: "provisioned", kind: "local", error: null, emailSent: true });
    expect(directory.users.get("anna@example.com")?.kind).toBe("local");
    const mail = mailer.sent.find((m) => m.to === "anna@example.com")!;
    expect(mail.subject).toBe("Invitasjon til MUNCH");
    expect(mail.text).toContain("Olga Owner har invitert deg");
    expect(mail.text).toContain("engangskode");
  });

  it("invites a work address as a guest and links the redeem URL", async () => {
    await withTenant(db, ctx, (tx) => tenancy.inviteMember(tx, ctx, "ola@work.test", "editor"));
    await drain();
    const inv = await invitation("ola@work.test");
    expect(inv.provisioning).toMatchObject({ status: "provisioned", kind: "work" });
    expect(mailer.sent.find((m) => m.to === "ola@work.test")!.text).toContain("https://login.example/redeem");
  });

  it("honours the owner's choice over the realm lookup", async () => {
    await withTenant(db, ctx, (tx) => tenancy.inviteMember(tx, ctx, "kari@example.org", "editor", "work"));
    await drain();
    expect((await invitation("kari@example.org")).provisioning.kind).toBe("work");
    expect(directory.calls).not.toContain("realm");
  });

  it("reuses an identity that already exists (a person in several accounts)", async () => {
    directory.users.set("both@example.com", { id: "existing-1", kind: "local" });
    await withTenant(db, ctx, (tx) => tenancy.inviteMember(tx, ctx, "both@example.com", "editor"));
    await drain();
    expect((await invitation("both@example.com")).provisioning.status).toBe("provisioned");
    expect(directory.calls).not.toContain("createLocalUser");
    const row = await admin.query(`select entra_object_id from tenancy.invitation where email = 'both@example.com'`);
    expect(row.rows[0].entra_object_id).toBe("existing-1");
  });

  it("records failures for the owner and succeeds on retry", async () => {
    directory.failNext = 1;
    await withTenant(db, ctx, (tx) => tenancy.inviteMember(tx, ctx, "flaky@example.com", "editor"));
    // One attempt only: the failure must be visible while the job waits to retry.
    await admin.query(`update graphile_worker._private_jobs set run_at = now()`);
    const taskList = buildTaskList(db, defaultHandlers, { directory, mailer, adminUrl: "https://admin.test/" });
    await runOnce({ connectionString: tdb.appUrl, taskList }); // dispatch → enqueue
    await runOnce({ connectionString: tdb.appUrl, taskList }); // provision → fails
    const failed = await invitation("flaky@example.com");
    expect(failed.provisioning).toMatchObject({ status: "failed", attempts: 1 });
    expect(failed.provisioning.error).toContain("fake realm failure");

    await drain(); // graphile-worker retries the same job
    const ok = await invitation("flaky@example.com");
    expect(ok.provisioning).toMatchObject({ status: "provisioned", attempts: 2, error: null, emailSent: true });
  });

  it("an owner retry resends the invitation without creating a second identity", async () => {
    const inv = await invitation("anna@example.com");
    directory.users.set("anna@example.com", { id: "local-anna", kind: "local" });
    await withTenant(db, ctx, (tx) => tenancy.retryInvitation(tx, ctx, inv.id));
    await drain();
    expect(mailer.sent.filter((m) => m.to === "anna@example.com")).toHaveLength(1);
    expect(directory.calls).not.toContain("createLocalUser");
    const editor: ActorContext = { ...ctx, roles: ["editor"] };
    await expect(withTenant(db, editor, (tx) => tenancy.retryInvitation(tx, editor, inv.id))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("provisions the bootstrap owner created by the CLI", async () => {
    await drain();
    const row = await admin.query(`select provision_status from tenancy.invitation where email = 'owner@munch.test'`);
    // Already accepted by the owner's first sign-in in beforeAll, so nothing is created.
    expect(row.rows[0].provision_status).toBe("pending");
    const fresh = await tenancy.createAccount(db, { slug: "prov-2", name: "Other", ownerEmail: "new-owner@example.com" });
    await drain();
    const r2 = await admin.query(`select provision_status, email_sent_at is not null as sent from tenancy.invitation where tenant_id = $1`, [fresh.id]);
    expect(r2.rows[0]).toEqual({ provision_status: "provisioned", sent: true });
  });
});
