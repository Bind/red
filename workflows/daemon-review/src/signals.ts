import type { DaemonSpec } from "../../../pkg/daemons/src/index";

const MAX_SUMMARY_ITEMS = 12;
const MAX_SUMMARY_EXCERPT_CHARS = 320;
const MAX_PROFILE_BODY_ITEMS = 24;
const MAX_PROFILE_ITEMS = 18;

export type DaemonProfileOptions = {
  trackedSubjectNames?: string[];
  invariantNames?: string[];
  trackedDependencyPaths?: string[];
};

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function clipText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function tokenizePath(path: string): string[] {
  return path
    .split(/[._/-]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

function collectMatches(source: string, pattern: RegExp, limit: number): string[] {
  const values: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const value = (match[1] ?? match[0] ?? "").trim();
    if (!value) continue;
    values.push(value);
    if (values.length >= limit) break;
  }
  return uniqueSorted(values);
}

function collectCommands(source: string): string[] {
  const commands: string[] = [];
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const segments = line.split(/&&|\|\||[|;]/g);
    for (const rawSegment of segments) {
      let segment = rawSegment.trim();
      if (segment.length === 0) continue;
      segment = segment.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/g, "");
      segment = segment
        .replace(/^[|>+-]\s*/, "")
        .replace(/^[-*]\s*/, "")
        .replace(/^`([^`]+)`$/, "$1");
      const first = segment.split(/\s+/)[0] ?? "";
      const token = first.replace(/[^a-zA-Z0-9:_./-]/g, "");
      if (
        token.length >= 2 &&
        !token.includes("=") &&
        !token.startsWith("./") &&
        token.toLowerCase() === token &&
        token !== "if" &&
        token !== "then" &&
        token !== "fi"
      ) {
        commands.push(token);
      }
    }
  }
  return uniqueInOrder(commands.filter((token) => /^[a-z]/.test(token))).slice(0, MAX_SUMMARY_ITEMS);
}

function collectHeadings(source: string): string[] {
  return uniqueSorted(
    source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^#{1,6}\s+/.test(line))
      .map((line) => line.replace(/^#{1,6}\s+/, "").trim()),
  ).slice(0, MAX_SUMMARY_ITEMS);
}

function collectComments(source: string): string[] {
  const commentLines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#") && !line.startsWith("#!"))
    .map((line) => line.replace(/^#+\s*/, ""))
    .filter((line) => line.length > 0);
  return commentLines.slice(0, 4);
}

function collectExcerpt(source: string): string {
  const excerpt = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 8)
    .join(" ");
  return clipText(excerpt, MAX_SUMMARY_EXCERPT_CHARS);
}

function collectBodyKeywords(body: string, limit: number): string[] {
  const inlineCode = collectMatches(body, /`([^`]+)`/g, limit);
  const headings = collectMatches(body, /^#{1,6}\s+(.+)$/gm, limit);
  const words = collectMatches(body.toLowerCase(), /\b([a-z][a-z0-9._/-]{3,})\b/g, limit * 4)
    .filter((token) =>
      token !== "daemon" &&
      token !== "review" &&
      token !== "responsible" &&
      token !== "complete" &&
      token !== "track"
    );
  return uniqueSorted([...inlineCode, ...headings, ...words]).slice(0, limit);
}

export function buildFileSummary(path: string, content: string): string {
  const parts = path.split("/");
  const filename = parts.at(-1) ?? path;
  const ext = filename.includes(".") ? filename.split(".").at(-1) ?? "" : "";
  const pathTokens = tokenizePath(path);
  const imports = collectMatches(
    content,
    /(?:^|\n)\s*import\s+.+?\s+from\s+["']([^"']+)["']|(?:^|\n)\s*require\(\s*["']([^"']+)["']\s*\)/g,
    MAX_SUMMARY_ITEMS,
  ).map((value) => value.replace(/^\n/, ""));
  const exports = collectMatches(
    content,
    /(?:^|\n)\s*export\s+(?:async\s+)?(?:function|const|class|type)\s+([A-Za-z0-9_]+)/g,
    MAX_SUMMARY_ITEMS,
  );
  const envVars = collectMatches(content, /\b([A-Z][A-Z0-9_]{2,})\b/g, MAX_SUMMARY_ITEMS);
  const configKeys = collectMatches(
    content,
    /(?:^|\n)\s*([a-zA-Z][a-zA-Z0-9._-]{2,})\s*:/g,
    MAX_SUMMARY_ITEMS,
  );
  const headings = collectHeadings(content);
  const commands = collectCommands(content);
  const comments = collectComments(content);
  const excerpt = collectExcerpt(content);

  const lines = [
    `File path: ${path}`,
    `Filename: ${filename}`,
    `Extension: ${ext || "(none)"}`,
    `Path tokens: ${pathTokens.join(", ") || "(none)"}`,
  ];

  if (imports.length > 0) lines.push(`Imports: ${imports.join(", ")}`);
  if (exports.length > 0) lines.push(`Exports: ${exports.join(", ")}`);
  if (envVars.length > 0) lines.push(`Env vars: ${envVars.join(", ")}`);
  if (configKeys.length > 0) lines.push(`Config keys: ${configKeys.join(", ")}`);
  if (commands.length > 0) lines.push(`Commands: ${commands.join(", ")}`);
  if (headings.length > 0) lines.push(`Headings: ${headings.join(" | ")}`);
  if (comments.length > 0) lines.push(`Comments: ${comments.join(" | ")}`);
  if (excerpt.length > 0) lines.push(`Excerpt: ${excerpt}`);

  return lines.join("\n");
}

export function buildDaemonProfile(
  spec: DaemonSpec,
  options: DaemonProfileOptions = {},
): string {
  const routingCategories = spec.review.routingCategories.map(
    (category) => `${category.name}: ${category.description}`,
  );
  const bodyKeywords = collectBodyKeywords(spec.body, MAX_PROFILE_BODY_ITEMS);
  const trackedSubjects = uniqueSorted(options.trackedSubjectNames ?? []).slice(0, MAX_PROFILE_ITEMS);
  const invariantNames = uniqueSorted(options.invariantNames ?? []).slice(0, MAX_PROFILE_ITEMS);
  const trackedDependencyPaths = uniqueSorted(options.trackedDependencyPaths ?? []).slice(0, MAX_PROFILE_ITEMS);

  const lines = [
    `Daemon: ${spec.name}`,
    `Description: ${spec.description}`,
  ];

  if (routingCategories.length > 0) {
    lines.push(`Routing categories: ${routingCategories.join(" | ")}`);
  }
  if (trackedSubjects.length > 0) {
    lines.push(`Tracked subjects: ${trackedSubjects.join(", ")}`);
  }
  if (trackedDependencyPaths.length > 0) {
    lines.push(`Tracked dependency paths: ${trackedDependencyPaths.join(", ")}`);
  }
  if (invariantNames.length > 0) {
    lines.push(`Invariant names: ${invariantNames.join(", ")}`);
  }
  if (bodyKeywords.length > 0) {
    lines.push(`Daemon keywords: ${bodyKeywords.join(", ")}`);
  }

  return lines.join("\n");
}
