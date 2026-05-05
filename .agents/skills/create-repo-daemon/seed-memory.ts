#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createDaemonMemoryStore,
  resolveDaemon,
  saveMemoryRecord,
} from "../../../pkg/daemons/src/index";

export async function seedEntry(input: {
  daemonName: string;
  root: string;
  subject: string;
  fact: unknown;
  dependsOn?: string[];
}): Promise<void> {
  const { daemonName, root, subject, fact, dependsOn = [] } = input;
  const spec = await resolveDaemon(daemonName, root);
  const store = await createDaemonMemoryStore(daemonName, spec.scopeRoot);
  const fingerprint = await computeFingerprint(fact, dependsOn, spec.scopeRoot);
  await store.record({
    subject,
    fingerprint,
    fact,
    depends_on: dependsOn.map((p) => resolve(spec.scopeRoot, p)),
    checked_at: new Date().toISOString(),
    source_run_id: `seed_${Date.now().toString(36)}`,
  });
  await saveMemoryRecord(store.snapshot(), spec.scopeRoot);
}

async function computeFingerprint(
  fact: unknown,
  dependsOn: string[],
  scopeRoot: string,
): Promise<string> {
  const hash = createHash("sha256");
  if (dependsOn.length > 0) {
    for (const rel of [...dependsOn].sort()) {
      try {
        hash.update(await readFile(resolve(scopeRoot, rel)));
      } catch {
        hash.update(rel);
      }
    }
  } else {
    hash.update(JSON.stringify(fact ?? null));
  }
  return hash.digest("hex").slice(0, 32);
}

// CLI entry point
if (import.meta.main) {
  const [daemonName, ...rest] = process.argv.slice(2);
  if (!daemonName) {
    console.error("Usage: seed-memory.ts <daemon-name> --subject <s> --fact <json> [--depends-on <path>]...");
    process.exit(1);
  }

  let subject = "";
  let fact: unknown = null;
  const dependsOn: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--subject" && rest[i + 1]) subject = rest[++i]!;
    else if (rest[i] === "--fact" && rest[i + 1]) fact = JSON.parse(rest[++i]!);
    else if (rest[i] === "--depends-on" && rest[i + 1]) dependsOn.push(rest[++i]!);
  }

  if (!subject) {
    console.error("--subject is required");
    process.exit(1);
  }

  await seedEntry({ daemonName, root: process.cwd(), subject, fact, dependsOn });
  console.log(`seeded: ${subject} → ${daemonName}`);
}
