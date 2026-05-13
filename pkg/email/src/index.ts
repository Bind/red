export interface CloudflareEmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CloudflareEmailSenderConfig {
  accountId: string;
  apiToken: string;
  from: string;
  senderName?: string;
  replyTo?: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}

export interface EmailSender {
  sendEmail(message: CloudflareEmailMessage): Promise<void>;
}

function formatFromAddress(from: string, senderName?: string): string {
  const trimmedName = senderName?.trim();
  return trimmedName ? `${trimmedName} <${from}>` : from;
}

export class CloudflareEmailService implements EmailSender {
  private readonly fetchImpl: FetchLike;
  private readonly apiBaseUrl: string;
  private readonly from: string;

  constructor(private readonly config: CloudflareEmailSenderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.apiBaseUrl = config.apiBaseUrl ?? "https://api.cloudflare.com/client/v4";
    this.from = formatFromAddress(config.from, config.senderName);
  }

  async sendEmail(message: CloudflareEmailMessage): Promise<void> {
    const headers: Record<string, string> = {
      ...(message.headers ?? {}),
    };
    if (this.config.replyTo) {
      headers["Reply-To"] = this.config.replyTo;
    }

    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/accounts/${this.config.accountId}/email/sending/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: message.to,
          from: this.from,
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        }),
      },
    );

    const bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(bodyText || `Cloudflare email send failed: ${response.status}`);
    }

    if (!bodyText.trim()) {
      return;
    }

    const body = JSON.parse(bodyText) as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
    };
    if (body.success === false) {
      const errorMessage = body.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join(", ");
      throw new Error(errorMessage || "Cloudflare email send failed");
    }
  }
}
