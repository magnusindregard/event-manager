import { FakeDirectory, GraphDirectory, type IdentityDirectory } from "./identity/directory.js";
import { FakeMailer, type Mailer, PostmarkMailer } from "./identity/mailer.js";
import type { ProvisionDeps } from "./provision.js";

/**
 * Picks real or fake integrations from the environment. Fakes are the default, so a local
 * stack never calls Graph or sends email by accident.
 *   IDENTITY_DIRECTORY=graph  GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_TENANT_DOMAIN, [GRAPH_CLIENT_SECRET]
 *   MAILER=postmark           POSTMARK_TOKEN, MAIL_FROM
 *   ADMIN_URL                 where invitees sign in
 */
export function provisionDepsFromEnv(env: NodeJS.ProcessEnv, log: (line: string) => void): ProvisionDeps {
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

  let mailer: Mailer;
  if (env.MAILER === "postmark") {
    if (!env.POSTMARK_TOKEN || !env.MAIL_FROM) throw new Error("POSTMARK_TOKEN and MAIL_FROM are required");
    mailer = new PostmarkMailer({ token: env.POSTMARK_TOKEN, from: env.MAIL_FROM });
  } else {
    mailer = new FakeMailer(log);
  }
  return { directory, mailer, adminUrl: env.ADMIN_URL ?? "http://localhost:5173/" };
}
