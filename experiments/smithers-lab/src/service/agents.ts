import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent } from "ai";

export function createResearchAgent(model: string): ToolLoopAgent {
  return new ToolLoopAgent({
    model: openai(model),
    instructions:
      "You are a pragmatic research assistant. Return concise, well-structured findings only.",
  });
}

export function createWriterAgent(model: string): ToolLoopAgent {
  return new ToolLoopAgent({
    model: openai(model),
    instructions:
      "You write short engineering briefs. Be specific, avoid fluff, and keep output easy to scan.",
  });
}
