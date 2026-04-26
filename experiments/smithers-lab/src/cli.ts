#!/usr/bin/env bun
import { runResearchBrief } from "./service/run-research-brief";
import { loadConfig } from "./util/config";

const topic =
  Bun.argv.slice(2).join(" ").trim() || "What is a sensible first Smithers experiment for red?";
const config = loadConfig();

const result = await runResearchBrief(config, {
  topic,
  audience: "engineering",
});

console.log(JSON.stringify(result, null, 2));
