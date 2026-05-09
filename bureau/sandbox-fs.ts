import { cp, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export function shouldCopyPath(source: string): boolean {
  const normalized = source.replaceAll("\\", "/");
  if (
    normalized.endsWith("/.git") ||
    normalized.includes("/.git/") ||
    normalized.endsWith("/node_modules") ||
    normalized.includes("/node_modules/") ||
    normalized.endsWith("/.turbo") ||
    normalized.includes("/.turbo/") ||
    normalized.endsWith("/.sst") ||
    normalized.includes("/.sst/") ||
    normalized.endsWith("/.codex-artifacts") ||
    normalized.includes("/.codex-artifacts/") ||
    normalized.endsWith("/.daemons-artifacts") ||
    normalized.includes("/.daemons-artifacts/")
  ) {
    return false;
  }
  return true;
}

export async function copyDirectoryContents(sourceRoot: string, destinationRoot: string): Promise<void> {
  const entries = await readdir(sourceRoot);
  for (const entry of entries) {
    await cp(join(sourceRoot, entry), join(destinationRoot, entry), {
      recursive: true,
      filter: shouldCopyPath,
    });
  }
}

export function resolveSandboxCwd(sourceRoot: string, destinationRoot: string, requestedCwd?: string): string {
  const normalizedSourceRoot = resolve(sourceRoot);
  const normalizedRequestedCwd = resolve(requestedCwd ?? normalizedSourceRoot);
  const relativeCwd = relative(normalizedSourceRoot, normalizedRequestedCwd);
  if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) {
    throw new Error(
      `sandbox cwd must stay inside sourceRoot: ${normalizedRequestedCwd} is outside ${normalizedSourceRoot}`,
    );
  }
  return relativeCwd ? join(destinationRoot, relativeCwd) : destinationRoot;
}
