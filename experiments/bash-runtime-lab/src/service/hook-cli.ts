import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import type { CommandJournalEvent, CommandNodeMetadata, FileMutation } from "../util/types";

type FileSnapshotEntry = {
  hash: string;
  size: number;
};

type PendingInvocation = {
  nodeId: string;
  visit: number;
  cwd: string;
  env: Record<string, string>;
  snapshot: Record<string, FileSnapshotEntry>;
};

type CacheEntry = {
  key: string;
  nodeId: string;
  visit: number;
  cwd: string;
  envFingerprint: string;
  exitCode: number;
  layerDir: string;
};

type HookState = {
  journal: CommandJournalEvent[];
  commandNodes: Record<string, CommandNodeMetadata>;
  visitCounts: Record<string, number>;
  pending: PendingInvocation[];
  cache: Record<string, CacheEntry>;
  dependencyHashes?: Record<string, string>;
  replayEnabled?: boolean;
};

function emptyState(): HookState {
  return {
    journal: [],
    commandNodes: {},
    visitCounts: {},
    pending: [],
    cache: {},
    replayEnabled: true,
  };
}

async function loadState(path: string): Promise<HookState> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return emptyState();
  }
  return (await file.json()) as HookState;
}

async function saveState(path: string, state: HookState) {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withStateLock<T>(statePath: string, run: () => Promise<T>): Promise<T> {
  const lockDir = `${statePath}.lock`;

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch {
      await sleep(10);
    }
  }

  try {
    return await run();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function mapToRecord(snapshot: Map<string, FileSnapshotEntry>): Record<string, FileSnapshotEntry> {
  return Object.fromEntries(snapshot.entries());
}

function recordToMap(snapshot: Record<string, FileSnapshotEntry>): Map<string, FileSnapshotEntry> {
  return new Map(Object.entries(snapshot));
}

async function scanWorkspace(
  root: string,
  current = root,
): Promise<Map<string, FileSnapshotEntry>> {
  const snapshot = new Map<string, FileSnapshotEntry>();
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return snapshot;
  }

  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      const nested = await scanWorkspace(root, absolutePath);
      for (const [path, value] of nested) {
        snapshot.set(path, value);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const contents = await readFile(absolutePath);
    snapshot.set(relative(root, absolutePath), {
      hash: createHash("sha256").update(contents).digest("hex"),
      size: contents.byteLength,
    });
  }

  return snapshot;
}

function parseEnv(input: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of input.split("\u0000")) {
    if (!entry) {
      continue;
    }
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return Object.fromEntries(
    Object.entries(env).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function fingerprintEnv(env: Record<string, string>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(Object.entries(env).sort(([left], [right]) => left.localeCompare(right))),
    )
    .digest("hex");
}

function fingerprintObject(input: Record<string, string>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(Object.entries(input).sort(([left], [right]) => left.localeCompare(right))),
    )
    .digest("hex");
}

function fingerprintSnapshot(snapshot: Map<string, FileSnapshotEntry>): string {
  return createHash("sha256")
    .update(
      JSON.stringify([...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))),
    )
    .digest("hex");
}

function diffSnapshots(
  before: Map<string, FileSnapshotEntry>,
  after: Map<string, FileSnapshotEntry>,
): FileMutation[] {
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const changes: FileMutation[] = [];

  for (const path of [...paths].sort()) {
    const left = before.get(path);
    const right = after.get(path);
    if (!left && right) {
      changes.push({ path, kind: "created", afterHash: right.hash });
      continue;
    }
    if (left && !right) {
      changes.push({ path, kind: "deleted", beforeHash: left.hash });
      continue;
    }
    if (left && right && (left.hash !== right.hash || left.size !== right.size)) {
      changes.push({
        path,
        kind: "updated",
        beforeHash: left.hash,
        afterHash: right.hash,
      });
    }
  }

  return changes;
}

function diffEnv(
  before: Record<string, string>,
  after: Record<string, string>,
): { set: Record<string, string>; unset: string[] } {
  const set: Record<string, string> = {};
  const unset: string[] = [];

  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value) {
      set[key] = value;
    }
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      unset.push(key);
    }
  }

  unset.sort();
  return { set, unset };
}

function metadataFor(
  nodeId: string,
  nodes: Record<string, CommandNodeMetadata>,
): CommandNodeMetadata {
  return (
    nodes[nodeId] ?? {
      nodeId,
      commandName: "<unknown>",
      commandText: "<unknown>",
      line: 0,
    }
  );
}

function computeCacheKey(
  nodeId: string,
  visit: number,
  metadata: CommandNodeMetadata,
  cwd: string,
  env: Record<string, string>,
  dependencyHashes: Record<string, string>,
  workspaceFingerprint: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        nodeId,
        visit,
        commandText: metadata.commandText,
        cwd,
        envFingerprint: fingerprintEnv(env),
        dependencyFingerprint: fingerprintObject(dependencyHashes),
        workspaceFingerprint,
      }),
    )
    .digest("hex");
}

async function copyLayerFiles(workspaceDir: string, layerDir: string, mutations: FileMutation[]) {
  for (const mutation of mutations) {
    if (mutation.kind === "deleted") {
      continue;
    }
    const source = join(workspaceDir, mutation.path);
    const target = join(layerDir, "files", mutation.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }
}

async function applyLayer(workspaceDir: string, layerDir: string) {
  const manifest = (await Bun.file(join(layerDir, "layer.json")).json()) as {
    fileMutations: FileMutation[];
  };

  for (const mutation of manifest.fileMutations) {
    const target = join(workspaceDir, mutation.path);
    if (mutation.kind === "deleted") {
      await rm(target, { force: true });
      continue;
    }
    const source = join(layerDir, "files", mutation.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }
}

function emitAssignments(assignments: Record<string, string | number>) {
  const lines = Object.entries(assignments).map(
    ([key, value]) => `${key}=${shellQuote(String(value))}`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  const [phase, statePath, workspaceDir, nodeId = "", cwd = "", arg6 = "", arg7 = ""] =
    process.argv.slice(2);
  if (!phase || !statePath || !workspaceDir) {
    throw new Error(
      "usage: hook-cli.ts <before|after> <statePath> <workspaceDir> [nodeId] [cwd] [arg6] [arg7]",
    );
  }

  const env = parseEnv(await Bun.stdin.text());

  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);

    if (phase === "before") {
      const metadata = metadataFor(nodeId, state.commandNodes);
      const visit = (state.visitCounts[nodeId] ?? 0) + 1;
      state.visitCounts[nodeId] = visit;
      const currentSnapshot = await scanWorkspace(workspaceDir);
      const key = computeCacheKey(
        nodeId,
        visit,
        metadata,
        cwd,
        env,
        state.dependencyHashes ?? {},
        fingerprintSnapshot(currentSnapshot),
      );
      const cacheEntry = state.replayEnabled === false ? undefined : state.cache[key];

      if (cacheEntry) {
        await applyLayer(workspaceDir, cacheEntry.layerDir);
        state.journal.push({
          seq: state.journal.length + 1,
          phase: "before",
          cached: true,
          nodeId,
          visit,
          commandName: metadata.commandName,
          commandText: metadata.commandText,
          line: metadata.line,
          cwd,
          env,
          at: new Date().toISOString(),
        });
        await saveState(statePath, state);
        emitAssignments({
          RED_ACTION: "replay",
          RED_EXIT: cacheEntry.exitCode,
        });
        return;
      }

      state.replayEnabled = false;
      state.pending.push({
        nodeId,
        visit,
        cwd,
        env,
        snapshot: mapToRecord(currentSnapshot),
      });
      state.journal.push({
        seq: state.journal.length + 1,
        phase: "before",
        cached: false,
        nodeId,
        visit,
        commandName: metadata.commandName,
        commandText: metadata.commandText,
        line: metadata.line,
        cwd,
        env,
        at: new Date().toISOString(),
      });
      await saveState(statePath, state);
      emitAssignments({
        RED_ACTION: "run",
        RED_EXIT: 0,
      });
      return;
    }

    const metadata = metadataFor(nodeId, state.commandNodes);
    const exitCode = Number.parseInt(arg6 || "0", 10) || 0;
    const action = arg7 || "run";
    const pendingIndex = [...state.pending]
      .map((entry, index) => ({ entry, index }))
      .reverse()
      .find((entry) => entry.entry.nodeId === nodeId)?.index;

    const pending =
      pendingIndex === undefined
        ? {
            nodeId,
            visit: state.visitCounts[nodeId] ?? 1,
            cwd,
            env: {},
            snapshot: {},
          }
        : state.pending.splice(pendingIndex, 1)[0];

    const currentSnapshot = await scanWorkspace(workspaceDir);
    const mutations =
      action === "replay" ? [] : diffSnapshots(recordToMap(pending.snapshot), currentSnapshot);

    if (action === "run") {
      const key = computeCacheKey(
        nodeId,
        pending.visit,
        metadata,
        pending.cwd,
        pending.env,
        state.dependencyHashes ?? {},
        fingerprintSnapshot(recordToMap(pending.snapshot)),
      );
      const layerDir = join(dirname(statePath), "layers", key);
      await rm(layerDir, { recursive: true, force: true });
      await mkdir(join(layerDir, "files"), { recursive: true });
      await copyLayerFiles(workspaceDir, layerDir, mutations);
      await Bun.write(
        join(layerDir, "layer.json"),
        `${JSON.stringify({ fileMutations: mutations }, null, 2)}\n`,
      );
      state.cache[key] = {
        key,
        nodeId,
        visit: pending.visit,
        cwd: pending.cwd,
        envFingerprint: fingerprintEnv(pending.env),
        exitCode,
        layerDir,
      };
    }

    state.journal.push({
      seq: state.journal.length + 1,
      phase: "after",
      cached: action === "replay",
      nodeId,
      visit: pending.visit,
      commandName: metadata.commandName,
      commandText: metadata.commandText,
      line: metadata.line,
      cwd,
      env,
      envDelta: diffEnv(pending.env, env),
      exitCode:
        action === "replay"
          ? Number.parseInt(process.env.RED_EXIT ?? `${exitCode}`, 10) || exitCode
          : exitCode,
      fileMutations: mutations,
      at: new Date().toISOString(),
    });
    await saveState(statePath, state);
  });
}

await main();
