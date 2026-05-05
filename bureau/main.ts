#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { runBureauCli } from "./cli";

if (import.meta.main) {
  const prompt = process.stdin.isTTY
    ? async () => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question("input> ");
        rl.close();
        return answer.trim() || null;
      }
    : undefined;

  const code = await runBureauCli(process.argv.slice(2), { prompt });
  process.exit(code);
}
