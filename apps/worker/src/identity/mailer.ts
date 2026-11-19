/** Transactional email (ADR 0010: Postmark). */
export interface MailAttachment {
  name: string;
  contentType: string;
  /** Base64. */
  content: string;
  /** Set to show the attachment inline: <img src="cid:{contentId}">. */
  contentId?: string;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
  /** Echoed back by Postmark's delivery webhooks. */
  metadata?: Record<string, string>;
}

export interface SentMail {
  /** The mail service's id for the message, matched against its delivery reports. */
  messageId: string | null;
}

export interface Mailer {
  send(msg: Mail): Promise<SentMail>;
}

/**
 * The mail service refused the message. Permanent when sending it again cannot help (an
 * invalid or inactive recipient, an account restriction, a bad token): the task records the
 * failure and stops instead of retrying for half an hour while the send looks stuck (#72).
 * Network errors, rate limits and 5xx are not MailErrors, or not permanent, and are retried.
 */
export class MailError extends Error {
  constructor(message: string, readonly status: number, readonly permanent: boolean) {
    super(message);
    this.name = "MailError";
  }
}

export const isPermanentMailError = (e: unknown): e is MailError => e instanceof MailError && e.permanent;

/** 4xx other than timeouts and rate limits: the same request fails the same way again. */
export const isPermanentStatus = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

/**
 * Sends, or gives up on a permanent rejection: logs it and resolves null, so the job ends
 * instead of retrying. Anything else throws, and graphile-worker retries the job.
 */
export async function sendOrGiveUp(mailer: Mailer, msg: Mail, logError: (line: string) => void, what: string): Promise<SentMail | null> {
  try {
    return await mailer.send(msg);
  } catch (e) {
    if (!isPermanentMailError(e)) throw e;
    logError(`${what}: rejected by the mail service, not retried: ${e.message}`);
    return null;
  }
}

export class PostmarkMailer implements Mailer {
  constructor(private readonly cfg: { token: string; from: string; stream?: string }) {}

  async send(msg: Mail): Promise<SentMail> {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "X-Postmark-Server-Token": this.cfg.token },
      body: JSON.stringify({
        From: this.cfg.from,
        To: msg.to,
        Subject: msg.subject,
        TextBody: msg.text,
        ...(msg.html ? { HtmlBody: msg.html } : {}),
        ...(msg.attachments?.length
          ? { Attachments: msg.attachments.map((a) => ({ Name: a.name, Content: a.content, ContentType: a.contentType, ...(a.contentId ? { ContentID: `cid:${a.contentId}` } : {}) })) }
          : {}),
        ...(msg.metadata ? { Metadata: msg.metadata } : {}),
        MessageStream: this.cfg.stream ?? "outbound",
      }),
    });
    if (!res.ok) throw new MailError(`Postmark → ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, isPermanentStatus(res.status));
    const body = (await res.json().catch(() => ({}))) as { MessageID?: unknown };
    return { messageId: typeof body.MessageID === "string" ? body.MessageID : null };
  }
}

/** Collects messages instead of sending them; logs a line so local runs show what would go out. */
export class FakeMailer implements Mailer {
  readonly sent: Mail[] = [];
  constructor(private readonly log: (line: string) => void = () => {}) {}

  async send(msg: Mail): Promise<SentMail> {
    this.sent.push(msg);
    this.log(`[fake mail] to=${msg.to} subject=${JSON.stringify(msg.subject)}`);
    return { messageId: `fake-${this.sent.length}` };
  }
}

export function invitationEmail(opts: {
  locale: string;
  accountName: string;
  invitedBy: string | null;
  adminUrl: string;
  kind: "work" | "local";
  redeemUrl: string | null;
}): { subject: string; text: string } {
  const nb = opts.locale.startsWith("n");
  const who = opts.invitedBy ? (nb ? `${opts.invitedBy} har invitert deg` : `${opts.invitedBy} has invited you`) : nb ? "Du er invitert" : "You have been invited";
  const link = opts.redeemUrl ?? opts.adminUrl;
  const how =
    opts.kind === "work"
      ? nb
        ? "Du logger inn med jobbkontoen din. Første gang ber Microsoft deg godta invitasjonen."
        : "You sign in with your work account. The first time, Microsoft asks you to accept the invitation."
      : nb
        ? "Du logger inn med e-postadressen din og får en engangskode på e-post. Du trenger ikke noe passord."
        : "You sign in with your email address and get a one-time code by email. No password is needed.";
  const subject = nb ? `Invitasjon til ${opts.accountName}` : `Invitation to ${opts.accountName}`;
  const text = [
    `${who} ${nb ? "til" : "to"} ${opts.accountName}.`,
    "",
    how,
    "",
    link,
  ].join("\n");
  return { subject, text };
}
