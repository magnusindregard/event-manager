import { describe, expect, it } from "vitest";
import { createCoreClient } from "../src/index.js";

describe("createCoreClient", () => {
  it("keeps a request bound to the account selected when it started", async () => {
    let selected = "account-a";
    let releaseToken!: (t: string) => void;
    const token = new Promise<string>((resolve) => (releaseToken = resolve));
    const seen: Request[] = [];
    const client = createCoreClient({
      baseUrl: "http://api.test",
      getToken: () => token,
      getAccountId: () => selected,
    });

    const pending = client.POST("/v1/account/invitations", {
      body: { email: "editor@example.com", role: "editor" },
      fetch: async (req: Request) => {
        seen.push(req);
        return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
      },
    });
    selected = "account-b";
    releaseToken("tok");
    await pending;

    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("account-id")).toBe("account-a");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok");
  });

  it("uses the newly selected account for requests started after a switch", async () => {
    let selected = "account-a";
    const seen: Request[] = [];
    const client = createCoreClient({ baseUrl: "http://api.test", getToken: async () => "tok", getAccountId: () => selected });
    const fetch = async (req: Request) => {
      seen.push(req);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    await client.GET("/v1/account", { fetch });
    selected = "account-b";
    await client.GET("/v1/account", { fetch });
    expect(seen.map((r) => r.headers.get("account-id"))).toEqual(["account-a", "account-b"]);
  });
});
