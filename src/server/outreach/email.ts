import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { getEmailConfig } from "@/lib/email/config";
import { normaliseEmail } from "@/server/discovery/normalize";

/** Email provider abstraction for institutional outreach. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ messageId: string }>;
}

export class EmailSendError extends Error {
  constructor(readonly code: "INVALID_RECIPIENT" | "REJECTED" | "TRANSIENT", readonly retryable: boolean) {
    super(`Email send failed: ${code}`);
    this.name = "EmailSendError";
  }
}

class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private readonly transporter: Transporter;
  constructor(private readonly from: string, replyTo: string | undefined, options: { host: string; port: number; secure: boolean; user?: string; password?: string }) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: options.user ? { user: options.user, pass: options.password } : undefined,
      // Plain text only; never read files or URLs while building a message.
      disableFileAccess: true,
      disableUrlAccess: true,
      connectionTimeout: 15_000,
      socketTimeout: 30_000,
    });
    this.replyTo = replyTo;
  }
  private readonly replyTo: string | undefined;

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    // Recipients come from public data: accept exactly one plain address, nothing the parser could reinterpret.
    const to = normaliseEmail(message.to);
    if (!to || to !== message.to) throw new EmailSendError("INVALID_RECIPIENT", false);
    try {
      const info = await this.transporter.sendMail({ from: this.from, to, replyTo: this.replyTo, subject: message.subject, text: message.text, headers: message.headers });
      if (info.rejected?.length) throw new EmailSendError("REJECTED", false);
      return { messageId: String(info.messageId ?? "") };
    } catch (error) {
      if (error instanceof EmailSendError) throw error;
      const code = (error as { responseCode?: number }).responseCode;
      // 5xx: the server permanently refused (bad mailbox, policy). Anything else may succeed later.
      throw code && code >= 500 ? new EmailSendError("REJECTED", false) : new EmailSendError("TRANSIENT", true);
    }
  }
}

let override: EmailProvider | null | undefined;
let configured: EmailProvider | null | undefined;

export function setEmailProviderForTests(provider: EmailProvider | null | undefined) {
  override = provider;
}

/** The configured provider, or null when EMAIL_PROVIDER=none. */
export function getEmailProvider(): EmailProvider | null {
  if (override !== undefined) return override;
  if (configured === undefined) {
    const config = getEmailConfig();
    configured = config.provider === "smtp" && config.host && config.from
      ? new SmtpEmailProvider(config.from, config.replyTo, { host: config.host, port: config.port, secure: config.secure, user: config.user, password: config.password })
      : null;
  }
  return configured;
}
