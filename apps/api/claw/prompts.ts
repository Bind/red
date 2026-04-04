import { readFileSync } from "node:fs";
import { join } from "node:path";

export function getPromptPath(name: string): string {
  return join(import.meta.dir, "prompts", `${name}.md`);
}

export function loadPromptTemplate(name: string): string {
  return readFileSync(getPromptPath(name), "utf8").trim();
}

export function renderPrompt(
  template: string,
  values: Record<string, string | number | undefined>
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    return value == null ? "" : String(value);
  });
}
