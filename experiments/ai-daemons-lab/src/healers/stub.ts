import type { Healer, SummarizeInput } from "./types";

export class StubHealer implements Healer {
  readonly name = "stub";

  async summarize(input: SummarizeInput): Promise<string> {
    return `[auto] ${input.title} (at ${input.commitSha})`;
  }
}
