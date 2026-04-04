import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { S3Client, write } from "bun";
import type { ClawArtifactStore, PersistedClawArtifacts } from "./types";

export interface MinioArtifactStoreConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  prefix?: string;
}

export class MinioClawArtifactStore implements ClawArtifactStore {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(private readonly config: MinioArtifactStoreConfig) {
    this.client = new S3Client({
      endpoint: `${config.useSSL ? "https" : "http"}://${config.endPoint}:${config.port}`,
      bucket: config.bucket,
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    });
    this.prefix = trimSlashes(config.prefix ?? "claw-runs");
  }

  async persistRunArtifacts(
    runId: string,
    inputDir: string,
    outputDir: string
  ): Promise<PersistedClawArtifacts> {
    const baseKey = joinKey(this.prefix, runId);
    const inputKeys = await this.uploadDirectory(inputDir, joinKey(baseKey, "input"));
    const outputKeys = await this.uploadDirectory(outputDir, joinKey(baseKey, "output"));

    const requestKey = inputKeys.find((key) => key.endsWith("/request.json")) ?? null;
    const resultKey = outputKeys.find((key) => key.endsWith("/result.json")) ?? null;
    const eventsKey = outputKeys.find((key) => key.endsWith("/agent-events.jsonl")) ?? null;

    return {
      baseKey,
      requestKey,
      resultKey,
      eventsKey,
      filesPrefix: joinKey(baseKey, "output/files"),
      rolloutPath: eventsKey ? this.toUri(eventsKey) : null,
    };
  }

  async readTextArtifact(
    runId: string,
    kind: "request" | "result" | "events"
  ): Promise<string | null> {
    const key = this.keyForArtifact(runId, kind);
    try {
      return await this.client.file(key).text();
    } catch {
      return null;
    }
  }

  private async uploadDirectory(rootDir: string, baseKey: string): Promise<string[]> {
    const files = await collectFiles(rootDir);
    const uploaded: string[] = [];

    for (const filePath of files) {
      const relPath = relative(rootDir, filePath).replaceAll("\\", "/");
      const objectKey = joinKey(baseKey, relPath);
      await write(this.client.file(objectKey, {
        type: contentTypeForPath(filePath),
      }), Bun.file(filePath));
      uploaded.push(objectKey);
    }

    return uploaded;
  }

  private toUri(key: string): string {
    return `s3://${this.config.bucket}/${key}`;
  }

  private keyForArtifact(runId: string, kind: "request" | "result" | "events"): string {
    const fileName =
      kind === "request"
        ? "request.json"
        : kind === "result"
          ? "result.json"
          : "agent-events.jsonl";
    const section = kind === "request" ? "input" : "output";
    return joinKey(this.prefix, runId, section, fileName);
  }
}

export class LocalClawArtifactStore implements ClawArtifactStore {
  constructor(private readonly rootDir: string = process.env.CLAW_ARTIFACTS_DIR ?? process.env.CODEX_ARTIFACTS_DIR ?? ".claw-artifacts") {}

  async persistRunArtifacts(
    runId: string,
    inputDir: string,
    outputDir: string
  ): Promise<PersistedClawArtifacts> {
    const runDir = getLocalArtifactRunDir(runId, this.rootDir);
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(runDir, { recursive: true });
    await cp(inputDir, join(runDir, "input"), { recursive: true });
    await cp(outputDir, join(runDir, "output"), { recursive: true });

    const outputRoot = join(runDir, "output");
    return {
      baseKey: runDir,
      requestKey: join(runDir, "input", "request.json"),
      resultKey: join(outputRoot, "result.json"),
      eventsKey: join(outputRoot, "agent-events.jsonl"),
      filesPrefix: join(outputRoot, "files"),
      rolloutPath: join(outputRoot, "agent-events.jsonl"),
    };
  }

  async readTextArtifact(
    runId: string,
    kind: "request" | "result" | "events"
  ): Promise<string | null> {
    const section = kind === "request" ? "input" : "output";
    const fileName =
      kind === "request"
        ? "request.json"
        : kind === "result"
          ? "result.json"
          : "agent-events.jsonl";

    try {
      return await readFile(join(getLocalArtifactRunDir(runId, this.rootDir), section, fileName), "utf8");
    } catch {
      return null;
    }
  }
}

export function getRequiredMinioArtifactStoreConfig(
  env: Record<string, string | undefined> = process.env
): MinioArtifactStoreConfig {
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing required env var: ${key}`);
    return value;
  };

  return {
    endPoint: required("MINIO_ENDPOINT"),
    port: parseInt(required("MINIO_PORT"), 10),
    useSSL: required("MINIO_USE_SSL").toLowerCase() === "true",
    accessKey: required("MINIO_ACCESS_KEY"),
    secretKey: required("MINIO_SECRET_KEY"),
    bucket: required("MINIO_BUCKET"),
    prefix: env.MINIO_PREFIX ?? "claw-runs",
  };
}

export function createMinioArtifactStoreFromEnv(
  env: Record<string, string | undefined> = process.env
): MinioClawArtifactStore | null {
  const requiredKeys = [
    "MINIO_ENDPOINT",
    "MINIO_PORT",
    "MINIO_USE_SSL",
    "MINIO_ACCESS_KEY",
    "MINIO_SECRET_KEY",
    "MINIO_BUCKET",
  ];
  if (!requiredKeys.every((key) => env[key])) {
    return null;
  }
  return new MinioClawArtifactStore(getRequiredMinioArtifactStoreConfig(env));
}

export function getLocalArtifactRunDir(
  runId: string,
  rootDir: string = process.env.CLAW_ARTIFACTS_DIR ?? process.env.CODEX_ARTIFACTS_DIR ?? ".claw-artifacts"
): string {
  return join(rootDir, runId);
}

async function collectFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function joinKey(...parts: string[]): string {
  return parts
    .map(trimSlashes)
    .filter(Boolean)
    .join("/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function contentTypeForPath(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".jsonl")) return "application/x-ndjson";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (path.endsWith(".diff") || path.endsWith(".patch")) return "text/x-diff; charset=utf-8";
  return "application/octet-stream";
}
