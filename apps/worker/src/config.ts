import { FakeHubSpot, HttpHubSpot } from "@event-manager/hubspot";
import type { HubSpotDeps } from "./hubspot/setup.js";
import { FakeDirectory, GraphDirectory, type IdentityDirectory } from "./identity/directory.js";
import { FakeMailer, type Mailer, PostmarkMailer } from "./identity/mailer.js";
import type { ProvisionDeps } from "./provision.js";
import type { RegistrationEmailDeps } from "./registration-email.js";
import { HttpVipps } from "@event-manager/vipps";
import type { PaymentsWorkerDeps } from "./payments.js";

/**
 * Picks real or fake integrations from the environment. Fakes are the default, so a local
 * stack never calls Graph or sends email by accident.
 *   IDENTITY_DIRECTORY=graph  GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_TENANT_DOMAIN, [GRAPH_CLIENT_SECRET]
 *   MAILER=postmark           POSTMARK_TOKEN, MAIL_FROM
 *   ADMIN_URL                 where invitees sign in
 *   ATTENDEE_URL              base of the hosted attendee pages (links in registration emails)
 */
export function provisionDepsFromEnv(env: NodeJS.ProcessEnv, log: (line: string) => void, mailer: Mailer = mailerFromEnv(env, log)): ProvisionDeps {
  let directory: IdentityDirectory;
  if (env.IDENTITY_DIRECTORY === "graph") {
    const { GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_TENANT_DOMAIN } = env;
    if (!GRAPH_TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_TENANT_DOMAIN) throw new Error("GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_TENANT_DOMAIN are required");
    directory = new GraphDirectory({
      tenantId: GRAPH_TENANT_ID,
      clientId: GRAPH_CLIENT_ID,
      tenantDomain: GRAPH_TENANT_DOMAIN,
      clientSecret: env.GRAPH_CLIENT_SECRET || undefined,
      managedIdentityClientId: env.AZURE_CLIENT_ID,
    });
  } else {
    directory = new FakeDirectory();
    log("identity directory: fake (set IDENTITY_DIRECTORY=graph to provision Entra identities)");
  }

  return { directory, mailer, adminUrl: env.ADMIN_URL ?? "http://localhost:5173/" };
}

/** MAILER=postmark with POSTMARK_TOKEN and MAIL_FROM sends for real; otherwise a fake that logs. */
export function mailerFromEnv(env: NodeJS.ProcessEnv, log: (line: string) => void): Mailer {
  if (env.MAILER === "postmark") {
    if (!env.POSTMARK_TOKEN || !env.MAIL_FROM) throw new Error("POSTMARK_TOKEN and MAIL_FROM are required");
    return new PostmarkMailer({ token: env.POSTMARK_TOKEN, from: env.MAIL_FROM });
  }
  return new FakeMailer(log);
}

/**
 * The hosted checkout's payment provider (docs/checkout.md). VIPPS=http calls Vipps; anything
 * else leaves the payment jobs off. The worker never uses the fake: a local stack's fake Vipps
 * lives in the attendee app's process, which settles payments on its return page.
 */
export function paymentsDepsFromEnv(env: NodeJS.ProcessEnv, mailer: Mailer, log: (line: string) => void): PaymentsWorkerDeps | null {
  if (env.VIPPS !== "http") {
    log("payments: off (set VIPPS=http to settle hosted checkout payments)");
    return null;
  }
  return { provider: new HttpVipps(), mailer };
}

/** ATTENDEE_URL: base of the hosted attendee pages, for the links in registration emails. */
export function registrationEmailDepsFromEnv(env: NodeJS.ProcessEnv, mailer: Mailer): RegistrationEmailDeps {
  return { mailer, attendeeUrl: env.ATTENDEE_URL ?? "http://localhost:3020" };
}

/**
 * HUBSPOT_CLIENT_ID + HUBSPOT_CLIENT_SECRET: our HubSpot app, to refresh tokens and call the
 * portals that connected (docs/hubspot.md). Without them HubSpot jobs are skipped.
 * HUBSPOT=fake (local only, with the API's): a fake portal that accepts any token.
 */
export function hubspotDepsFromEnv(env: NodeJS.ProcessEnv, log: (line: string) => void): HubSpotDeps | null {
  if (env.HUBSPOT === "fake") {
    if (env.NODE_ENV === "production") throw new Error("HUBSPOT=fake must not be set in production");
    log("hubspot: fake portal 1000");
    return { client: new FakeHubSpot(log, { redirectUrl: "", portalId: "1000" }) };
  }
  if (!env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_CLIENT_SECRET) {
    log("hubspot: not configured (set HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET)");
    return null;
  }
  // The worker never exchanges codes, so it needs no redirect URL.
  return { client: new HttpHubSpot({ clientId: env.HUBSPOT_CLIENT_ID, clientSecret: env.HUBSPOT_CLIENT_SECRET, redirectUrl: "" }) };
}
