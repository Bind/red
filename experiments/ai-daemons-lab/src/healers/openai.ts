import type { Healer, SummarizeInput } from "./types";

export type OpenAIHealerOptions = {
  apiKey: string;
  model: string;
  endpoint?: string;
};

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

export class OpenAIHealer implements Healer {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;

  constructor(options: OpenAIHealerOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/chat/completions";
  }

  async summarize(input: SummarizeInput): Promise<string> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "You are a daemon that keeps PR summaries current. Reply with one short sentence.",
          },
          {
            role: "user",
            content: `Change ${input.changeId} titled "${input.title}" at commit ${input.commitSha}. Summarize.`,
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`openai ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as ChatResponse;
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("openai response missing content");
    return content;
  }
}

export function maybeOpenAIHealerFromEnv(env: NodeJS.ProcessEnv = process.env): Healer | null {
  const apiKey = env.AI_DAEMONS_OPENAI_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = env.AI_DAEMONS_OPENAI_MODEL ?? "gpt-5-mini";
  return new OpenAIHealer({ apiKey, model });
}
