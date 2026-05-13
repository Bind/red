import { describe, expect, test } from "bun:test";
import { CloudflareEmailService } from "./index";

describe("@red/email", () => {
  test("posts Cloudflare Email Service payload with formatted sender", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sender = new CloudflareEmailService({
      accountId: "acct-test",
      apiToken: "token-test",
      from: "auth@red.computer",
      senderName: "red auth",
      replyTo: "support@red.computer",
      apiBaseUrl: "https://email.test",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ success: true, errors: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await sender.sendEmail({
      to: "douglasjbinder@gmail.com",
      subject: "red test",
      text: "hello",
      html: "<p>hello</p>",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://email.test/accounts/acct-test/email/sending/send");
    expect(calls[0]?.init?.method).toBe("POST");

    const body = JSON.parse(String(calls[0]?.init?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({
      to: "douglasjbinder@gmail.com",
      from: "red auth <auth@red.computer>",
      subject: "red test",
      text: "hello",
      html: "<p>hello</p>",
    });
    expect(body.headers).toMatchObject({
      "Reply-To": "support@red.computer",
    });
  });
});
