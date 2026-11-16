import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { tenancy } from "@event-manager/domain";
import { Me, Problem } from "@event-manager/schemas";

export const meRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/me",
    {
      preHandler: app.authenticate,
      schema: {
        operationId: "getMe",
        tags: ["identity"],
        summary: "The signed-in user and the accounts they belong to",
        security: [{ bearer: [] }],
        response: { 200: Me, 401: Problem },
      },
    },
    async (req) => {
      const id = req.identity!;
      const accounts = await tenancy.myAccounts(app.db, id.userId);
      return { userId: id.userId, email: id.email.toLowerCase(), name: id.name, accounts };
    },
  );
};
