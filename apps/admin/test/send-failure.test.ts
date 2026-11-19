import { describe, expect, it } from "vitest";
import { sendFailure } from "../src/lib/send-failure.js";

const rejected = (code: number) => `mail_rejected: Postmark → 422: {"ErrorCode":${code},"Message":"…"}`;

describe("why an invitation send failed", () => {
  it("reads the mail service's error code", () => {
    expect(sendFailure(rejected(412))).toBe("accountPending");
    expect(sendFailure(rejected(300))).toBe("recipient");
    expect(sendFailure(rejected(406))).toBe("recipient");
    expect(sendFailure(rejected(401))).toBe("rejected");
    expect(sendFailure("mail_rejected: Postmark → 401: no json")).toBe("rejected");
  });

  it("tells retries running out apart from rejections", () => {
    expect(sendFailure("mail_error: Postmark → 500: down")).toBe("unavailable");
  });

  it("explains sends skipped by the worker", () => {
    expect(sendFailure("event_not_published")).toBe("notPublished");
    expect(sendFailure("guest_accepted")).toBe("answered");
    expect(sendFailure("guest_declined")).toBe("answered");
  });

  it("falls back for anything else", () => {
    expect(sendFailure(null)).toBe("unknown");
    expect(sendFailure("something new")).toBe("unknown");
  });
});
