import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import matter from "gray-matter";
import { DaemonFrontmatter } from "./schema";

export type DaemonSpec = {
  name: string;
  description: string;
  file: string;
  scopeRoot: string;
  body: string;
  review: {
    maxTurns: number;
    routingCategories: Array<{
      name: string;
      description: string;
    }>;
  };
};

export type LoadError = {
  file: string;
  message: string;
};

export type LoadResult = {
  specs: DaemonSpec[];
  errors: LoadError[];
};

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".bun-tmp",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

async function* walk(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".daemons") {
      if (!entry.isDirectory()) continue;
    }
    if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".daemon.md")) {
      yield full;
    }
  }
}

export async function loadDaemons(root: string = process.cwd()): Promise<LoadResult> {
  const absRoot = resolve(root);
  const specs: DaemonSpec[] = [];
  const errors: LoadError[] = [];
  const seenNames = new Map<string, string>();

  for await (const file of walk(absRoot)) {
    try {
      const raw = await readFile(file, "utf8");
      const { data, content } = matter(raw);
      const parsed = DaemonFrontmatter.safeParse(data);
      if (!parsed.success) {
        errors.push({
          file,
          message: `invalid frontmatter: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ")}`,
        });
        continue;
      }
      const previous = seenNames.get(parsed.data.name);
      if (previous) {
        errors.push({
          file,
          message: `duplicate daemon name "${parsed.data.name}" (also defined in ${relative(absRoot, previous)})`,
        });
        continue;
      }
      seenNames.set(parsed.data.name, file);
      specs.push({
        name: parsed.data.name,
        description: parsed.data.description,
        file,
        scopeRoot: dirname(file),
        body: content.trim(),
        review: {
          maxTurns: parsed.data.review?.max_turns ?? 18,
          routingCategories: parsed.data.review?.routing_categories ?? [],
        },
      });
    } catch (err) {
      errors.push({
        file,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  specs.sort((a, b) => a.name.localeCompare(b.name));
  return { specs, errors };
}

export async function resolveDaemon(name: string, root?: string): Promise<DaemonSpec> {
  const { specs, errors } = await loadDaemons(root);
  const hit = specs.find((s) => s.name === name);
  if (hit) return hit;
  if (errors.length > 0) {
    throw new Error(
      `daemon "${name}" not found. Load errors:\n${errors
        .map((e) => `  ${e.file}: ${e.message}`)
        .join("\n")}`,
    );
  }
  throw new Error(`daemon "${name}" not found under ${root ?? process.cwd()}`);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
