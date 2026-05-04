#!/usr/bin/env bun
import { runBureauCli } from "./cli";

if (import.meta.main) {
  const code = await runBureauCli(process.argv.slice(2));
  process.exit(code);
}
