// Why an invitation send failed, for the guest list. The worker records the reason as
// delivery_detail (apps/worker/src/invitation-email.ts): a code of ours, or the mail
// service's own error after "mail_rejected:" / "mail_error:". Staff see a short, plain
// reason; the raw detail stays available as a tooltip.

export type SendFailure = "accountPending" | "recipient" | "rejected" | "unavailable" | "notPublished" | "answered" | "unknown";

/** Postmark error codes (postmarkapp.com/developer/api/overview#error-codes). */
const ACCOUNT_PENDING = 412; // pending approval: only recipients on the From domain
const RECIPIENT = new Set([300, 406]); // invalid address; inactive recipient (bounced or unsubscribed before)

export function sendFailure(detail: string | null | undefined): SendFailure {
  if (!detail) return "unknown";
  if (detail === "event_not_published") return "notPublished";
  if (detail.startsWith("guest_")) return "answered";
  if (detail.startsWith("mail_error:")) return "unavailable";
  if (detail.startsWith("mail_rejected:")) {
    const code = Number(/"ErrorCode"\s*:\s*(\d+)/.exec(detail)?.[1]);
    if (code === ACCOUNT_PENDING) return "accountPending";
    if (RECIPIENT.has(code)) return "recipient";
    return "rejected";
  }
  return "unknown";
}
