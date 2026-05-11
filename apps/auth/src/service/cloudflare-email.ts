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

export function createCloudflareEmailSender(config: CloudflareEmailSenderConfig): EmailSender {
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiBaseUrl = config.apiBaseUrl ?? "https://api.cloudflare.com/client/v4";
  const from = formatFromAddress(config.from, config.senderName);

  return {
    async sendEmail(message) {
      const headers: Record<string, string> = {
        ...(message.headers ?? {}),
      };
      if (config.replyTo) {
        headers["Reply-To"] = config.replyTo;
      }

      const response = await fetchImpl(
        `${apiBaseUrl}/accounts/${config.accountId}/email/sending/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: message.to,
            from,
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
        const message = body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join(", ");
        throw new Error(message || "Cloudflare email send failed");
      }
    },
  };
}
