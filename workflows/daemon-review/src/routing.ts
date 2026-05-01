import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DaemonSpec } from "../../../pkg/daemons/src/index";
import { S3Client, write } from "bun";
import type { DaemonRoutingMemory } from "./routing-memory";
import { reviewLogger } from "./logger";
import { buildDaemonProfile, buildFileSummary } from "./signals";

export type RoutedDaemon = {
  name: string;
  relevantFiles: string[];
};

type FileTextResolver = (path: string) => Promise<string>;
type EmbeddingVector = Float32Array;
type SemanticScores = Map<string, number>;
type SemanticScorer = (
  fileSummary: string,
  daemonProfiles: Array<{ daemonName: string; profile: string }>,
) => Promise<SemanticScores>;
type LibrarianDecision = {
  selectedDaemons: string[];
  rationale?: string;
  confidence?: number;
};
type LibrarianCandidate = {
  daemonName: string;
  profile: string;
  trackedSubjects: string[];
  trackedDependencyPaths: string[];
  semanticScore: number;
  scoreBoost: number;
  finalScore: number;
  dependencyExact: boolean;
  checkedExact: boolean;
  pathNeighborScore: number;
};
type Librarian = (input: {
  file: string;
  fileSummary: string;
  candidates: LibrarianCandidate[];
}) => Promise<LibrarianDecision>;

const DEFAULT_ROUTER_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_ROUTER_PROVIDER = "local";
const DEFAULT_SCORE_THRESHOLD = 0.45;
const DEFAULT_SCORE_GAP = 0.08;
const DEFAULT_TOP_K = 3;
const DEFAULT_ROUTER_MODE = "memory_embedding";
const DEFAULT_LIBRARIAN_MODEL = "deepseek/deepseek-v4-flash";

let scorerPromise: Promise<SemanticScorer> | null = null;
const scorerPromiseByKey = new Map<string, Promise<SemanticScorer>>();
const processEmbeddingCache = new Map<string, EmbeddingVector>();
let minioEmbeddingCache: MinioEmbeddingCache | null | undefined;

type RouteDaemonsOptions = {
  semanticScorerOverride?: SemanticScorer;
  librarianOverride?: Librarian;
  fileTextResolver?: FileTextResolver;
  memoryByDaemon?: Map<string, DaemonRoutingMemory>;
  modeOverride?: RouterMode;
  routerProviderOverride?: RouterProvider;
  routerModelOverride?: string;
  librarianModelOverride?: string;
};

type StructuredRoutingSignal = {
  dependencyExact: boolean;
  checkedExact: boolean;
  pathNeighborScore: number;
  scoreBoost: number;
};

type EmbeddingCacheStats = {
  totalTexts: number;
  uniqueKeys: number;
  processHits: number;
  remoteHits: number;
  misses: number;
  providerCalls: number;
  durationMs: number;
};

class MinioEmbeddingCache {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor() {
    const endpoint = process.env.MINIO_ENDPOINT;
    const port = process.env.MINIO_PORT;
    const useSSL = process.env.MINIO_USE_SSL?.toLowerCase() === "true";
    const accessKey = process.env.MINIO_ACCESS_KEY;
    const secretKey = process.env.MINIO_SECRET_KEY;
    const bucket = process.env.MINIO_BUCKET;

    if (!endpoint || !port || !accessKey || !secretKey || !bucket) {
      throw new Error("missing MINIO_* env for embedding cache");
    }

    this.client = new S3Client({
      endpoint: `${useSSL ? "https" : "http"}://${endpoint}:${port}`,
      bucket,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    });
    this.prefix = trimSlashes(process.env.DAEMON_REVIEW_EMBEDDING_CACHE_PREFIX ?? "daemon-review/embeddings/v1");
  }

  async get(key: string): Promise<EmbeddingVector | null> {
    try {
      const payload = await this.client.file(this.objectKey(key)).json() as { embedding?: number[] };
      return Array.isArray(payload.embedding) ? Float32Array.from(payload.embedding) : null;
    } catch {
      return null;
    }
  }

  async put(key: string, embedding: EmbeddingVector): Promise<void> {
    const payload = JSON.stringify({ embedding: Array.from(embedding) });
    await write(
      this.client.file(this.objectKey(key), {
        type: "application/json",
      }),
      payload,
    );
  }

  private objectKey(key: string): string {
    return joinKey(this.prefix, key);
  }
}

export type FileDaemonScore = {
  daemonName: string;
  semanticScore: number;
  scoreBoost: number;
  finalScore: number;
  dependencyExact: boolean;
  checkedExact: boolean;
  pathNeighborScore: number;
  selected: boolean;
};

export type FileRoutingDebug = {
  file: string;
  fileSummary: string;
  selectedDaemons: string[];
  scores: FileDaemonScore[];
  mode: RouterMode;
  librarianRationale?: string;
  librarianConfidence?: number;
};

export type RoutingEvaluation = {
  routedDaemons: RoutedDaemon[];
  fileDebug: FileRoutingDebug[];
};

export type RouterMode =
  | "memory_only"
  | "embedding_only"
  | "memory_embedding"
  | "memory_embedding_librarian";

export type RouterProvider = "local" | "openrouter";

export function reviewParallelism(totalDaemons: number): number {
  const raw = process.env.DAEMON_REVIEW_MAX_PARALLEL;
  const parsed = raw ? Number.parseInt(raw, 10) : 3;
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(totalDaemons, parsed);
}

export function routerModel(): string {
  return process.env.DAEMON_REVIEW_ROUTER_MODEL ?? DEFAULT_ROUTER_MODEL;
}

export function routerProvider(): RouterProvider {
  const raw = process.env.DAEMON_REVIEW_ROUTER_PROVIDER ?? DEFAULT_ROUTER_PROVIDER;
  if (raw === "openrouter") return "openrouter";
  return "local";
}

export function routerMode(): RouterMode {
  const raw = process.env.DAEMON_REVIEW_ROUTER_MODE ?? DEFAULT_ROUTER_MODE;
  if (
    raw === "memory_only" ||
    raw === "embedding_only" ||
    raw === "memory_embedding" ||
    raw === "memory_embedding_librarian"
  ) {
    return raw;
  }
  return DEFAULT_ROUTER_MODE;
}

export function librarianModel(): string {
  return process.env.DAEMON_REVIEW_LIBRARIAN_MODEL ?? DEFAULT_LIBRARIAN_MODEL;
}

function routerScoreThreshold(): number {
  const raw = process.env.DAEMON_REVIEW_ROUTER_SCORE_THRESHOLD;
  const parsed = raw ? Number.parseFloat(raw) : DEFAULT_SCORE_THRESHOLD;
  return Number.isFinite(parsed) ? parsed : DEFAULT_SCORE_THRESHOLD;
}

function routerScoreGap(): number {
  const raw = process.env.DAEMON_REVIEW_ROUTER_MAX_GAP;
  const parsed = raw ? Number.parseFloat(raw) : DEFAULT_SCORE_GAP;
  return Number.isFinite(parsed) ? parsed : DEFAULT_SCORE_GAP;
}

function routerTopK(): number {
  const raw = process.env.DAEMON_REVIEW_ROUTER_TOP_K;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_TOP_K;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOP_K;
}

function logRoutingDebug(message: string, fields?: Record<string, unknown>): void {
  if (!fields || Object.keys(fields).length === 0) {
    reviewLogger.info("{message}", { message });
    return;
  }
  reviewLogger.info("{message}", { message, ...fields });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function clipText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function joinKey(...parts: string[]): string {
  return parts.map(trimSlashes).filter(Boolean).join("/");
}

function directoryOf(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function pathNeighborScore(file: string, candidates: string[]): number {
  const fileDir = directoryOf(file);
  const fileParts = file.split("/");
  let best = 0;
  for (const candidate of candidates) {
    const candidateDir = directoryOf(candidate);
    if (candidateDir.length > 0 && candidateDir === fileDir) {
      best = Math.max(best, 0.36);
      continue;
    }
    const candidateParts = candidate.split("/");
    const sharedSegments = fileParts.filter((part, index) => candidateParts[index] === part).length;
    if (sharedSegments >= 2) {
      best = Math.max(best, 0.18);
      continue;
    }
    if (sharedSegments >= 1) {
      best = Math.max(best, 0.06);
    }
  }
  return best;
}

function structuredSignalForFile(
  file: string,
  memory: DaemonRoutingMemory | undefined,
): StructuredRoutingSignal {
  if (!memory) {
    return {
      dependencyExact: false,
      checkedExact: false,
      pathNeighborScore: 0,
      scoreBoost: 0,
    };
  }

  const dependencyFiles = memory.dependencyFiles;
  const checkedFiles = memory.checkedFiles;
  const dependencyExact = dependencyFiles.includes(file);
  const checkedExact = checkedFiles.includes(file);
  const neighborScore = pathNeighborScore(file, [...dependencyFiles, ...checkedFiles]);

  return {
    dependencyExact,
    checkedExact,
    pathNeighborScore: (!dependencyExact && !checkedExact) ? neighborScore : 0,
    scoreBoost:
      (dependencyExact ? 0.5 : 0) +
      (checkedExact ? 0.25 : 0) +
      ((!dependencyExact && !checkedExact) ? neighborScore : 0),
  };
}

async function defaultFileTextResolver(path: string): Promise<string> {
  try {
    const raw = await readFile(path, "utf8");
    return clipText(raw.replace(/\0/g, " "), 4_000);
  } catch {
    return "";
  }
}

async function getChangedFileText(path: string, fileTextResolver: FileTextResolver): Promise<string> {
  const content = await fileTextResolver(path);
  return buildFileSummary(path, content);
}

function vectorFromData(data: ArrayLike<number>): EmbeddingVector {
  return Float32Array.from(Array.from(data, (value) => Number(value)));
}

function unpackBatchEmbeddings(data: ArrayLike<number>, dims: number[]): EmbeddingVector[] {
  if (dims.length !== 2) {
    throw new Error(`expected embedding tensor with 2 dims, got ${dims.join("x")}`);
  }
  const [rows, cols] = dims;
  const raw = vectorFromData(data);
  const out: EmbeddingVector[] = [];
  for (let row = 0; row < rows; row += 1) {
    out.push(raw.slice(row * cols, (row + 1) * cols));
  }
  return out;
}

function dot(a: EmbeddingVector, b: EmbeddingVector): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    total += a[i]! * (b[i] ?? 0);
  }
  return total;
}

function shouldUseMinioEmbeddingCache(): boolean {
  const backend = process.env.DAEMON_REVIEW_EMBEDDING_CACHE_BACKEND ?? "minio";
  if (backend === "none") return false;
  return Boolean(
    process.env.MINIO_ENDPOINT &&
    process.env.MINIO_PORT &&
    process.env.MINIO_ACCESS_KEY &&
    process.env.MINIO_SECRET_KEY &&
    process.env.MINIO_BUCKET,
  );
}

function getMinioEmbeddingCache(): MinioEmbeddingCache | null {
  if (minioEmbeddingCache !== undefined) {
    return minioEmbeddingCache;
  }
  minioEmbeddingCache = shouldUseMinioEmbeddingCache() ? new MinioEmbeddingCache() : null;
  return minioEmbeddingCache;
}

function normalizeModelKey(modelId: string): string {
  return modelId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function embeddingCacheKey(provider: RouterProvider, modelId: string, text: string): string {
  const hash = createHash("sha256").update(text).digest("hex");
  return joinKey(provider, normalizeModelKey(modelId), hash.slice(0, 2), `${hash}.json`);
}

async function resolveEmbeddingsWithCache(
  provider: RouterProvider,
  modelId: string,
  texts: string[],
  computeMisses: (texts: string[]) => Promise<EmbeddingVector[]>,
): Promise<{ embeddings: EmbeddingVector[]; stats: EmbeddingCacheStats }> {
  const startedAt = performance.now();
  const results = new Array<EmbeddingVector>(texts.length);
  const keyToText = new Map<string, string>();
  const keyToIndexes = new Map<string, number[]>();
  let processHits = 0;
  let remoteHits = 0;
  let providerCalls = 0;

  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index] ?? "";
    const key = embeddingCacheKey(provider, modelId, text);
    keyToText.set(key, text);
    const indexes = keyToIndexes.get(key) ?? [];
    indexes.push(index);
    keyToIndexes.set(key, indexes);
    const cached = processEmbeddingCache.get(key);
    if (cached) {
      results[index] = cached;
      processHits += 1;
    }
  }

  const unresolvedKeys = [...keyToIndexes.keys()].filter((key) => !processEmbeddingCache.has(key));
  const remoteCache = getMinioEmbeddingCache();

  if (remoteCache && unresolvedKeys.length > 0) {
    const remoteEntries = await Promise.all(unresolvedKeys.map(async (key) => [key, await remoteCache.get(key)] as const));
    for (const [key, embedding] of remoteEntries) {
      if (!embedding) continue;
      processEmbeddingCache.set(key, embedding);
      remoteHits += (keyToIndexes.get(key) ?? []).length;
      for (const index of keyToIndexes.get(key) ?? []) {
        results[index] = embedding;
      }
    }
  }

  const missingKeys = unresolvedKeys.filter((key) => !processEmbeddingCache.has(key));
  if (missingKeys.length > 0) {
    const missTexts = missingKeys.map((key) => keyToText.get(key) ?? "");
    providerCalls += 1;
    const computed = await computeMisses(missTexts);
    if (computed.length !== missingKeys.length) {
      throw new Error(`embedding scorer returned ${computed.length} vectors for ${missingKeys.length} texts`);
    }
    const remoteWrites: Promise<void>[] = [];
    for (let i = 0; i < missingKeys.length; i += 1) {
      const key = missingKeys[i]!;
      const embedding = computed[i]!;
      processEmbeddingCache.set(key, embedding);
      for (const index of keyToIndexes.get(key) ?? []) {
        results[index] = embedding;
      }
      if (remoteCache) {
        remoteWrites.push(remoteCache.put(key, embedding).catch(() => undefined));
      }
    }
    await Promise.all(remoteWrites);
  }

  const embeddings = results.map((embedding, index) => {
    if (!embedding) {
      throw new Error(`missing embedding for text index ${index}`);
    }
    return embedding;
  });
  const stats = {
    totalTexts: texts.length,
    uniqueKeys: keyToIndexes.size,
    processHits,
    remoteHits,
    misses: missingKeys.length,
    providerCalls,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  } satisfies EmbeddingCacheStats;
  logRoutingDebug("embedding_batch", {
    provider,
    model: modelId,
    ...stats,
  });
  return { embeddings, stats };
}

async function createSemanticScorer(modelId: string): Promise<SemanticScorer> {
  return createLocalSemanticScorer(modelId);
}

async function createLocalSemanticScorer(modelId: string): Promise<SemanticScorer> {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.allowRemoteModels = process.env.DAEMON_REVIEW_ROUTER_ALLOW_REMOTE_MODELS !== "false";
  const localModelPath = process.env.DAEMON_REVIEW_ROUTER_LOCAL_MODEL_PATH;
  if (localModelPath) {
    env.localModelPath = localModelPath;
  }
  const extractor = await pipeline("feature-extraction", modelId);
  return async (fileSummary, daemonProfiles) => {
    const texts = [fileSummary, ...daemonProfiles.map((entry) => entry.profile)];
    const { embeddings } = await resolveEmbeddingsWithCache("local", modelId, texts, async (missTexts) => {
      const tensor = await extractor(missTexts, {
        pooling: "mean",
        normalize: true,
      });
      return unpackBatchEmbeddings(tensor.data as ArrayLike<number>, tensor.dims);
    });
    const [fileEmbedding, ...daemonEmbeddings] = embeddings;
    if (!fileEmbedding) throw new Error("missing file embedding");

    const scores = new Map<string, number>();
    for (let i = 0; i < daemonProfiles.length; i += 1) {
      const daemon = daemonProfiles[i];
      const embedding = daemonEmbeddings[i];
      if (!daemon || !embedding) continue;
      scores.set(daemon.daemonName, dot(fileEmbedding, embedding));
    }
    return scores;
  };
}

function createOpenRouterEmbeddingScorer(modelId: string): SemanticScorer {
  return async (fileSummary, daemonProfiles) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is required for openrouter embedding routing");
    }

    const input = [fileSummary, ...daemonProfiles.map((entry) => entry.profile)];
    const { embeddings } = await resolveEmbeddingsWithCache("openrouter", modelId, input, async (missTexts) => {
      const providerOrder = (process.env.DAEMON_REVIEW_ROUTER_PROVIDER_ORDER ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

      const body: Record<string, unknown> = {
        model: modelId,
        input: missTexts,
        encoding_format: "float",
      };
      if (providerOrder.length > 0) {
        body.provider = {
          order: providerOrder,
          allow_fallbacks: true,
          data_collection: "deny",
        };
      }

      const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const details = await response.text().catch(() => "");
        throw new Error(`openrouter embeddings failed (${response.status}): ${details}`);
      }

      const payload = await response.json() as {
        data?: Array<{ embedding?: number[] | null }>;
      };
      return (payload.data?.map((entry) => entry.embedding ?? null) ?? []).map((embedding, index) => {
        if (!Array.isArray(embedding)) {
          throw new Error(`openrouter embeddings response missing embedding at index ${index}`);
        }
        return Float32Array.from(embedding);
      });
    });
    const [fileEmbeddingRaw, ...daemonEmbeddingsRaw] = embeddings;
    if (!(fileEmbeddingRaw instanceof Float32Array)) {
      throw new Error("openrouter embeddings response missing file embedding");
    }

    const fileEmbedding = fileEmbeddingRaw;
    const scores = new Map<string, number>();
    for (let i = 0; i < daemonProfiles.length; i += 1) {
      const daemon = daemonProfiles[i];
      const embeddingRaw = daemonEmbeddingsRaw[i];
      if (!daemon || !(embeddingRaw instanceof Float32Array)) continue;
      scores.set(daemon.daemonName, dot(fileEmbedding, embeddingRaw));
    }
    return scores;
  };
}

async function getSemanticScorer(provider: RouterProvider, modelId: string): Promise<SemanticScorer> {
  const cacheKey = `${provider}:${modelId}`;
  if (provider === routerProvider() && modelId === routerModel()) {
    if (!scorerPromise) {
      scorerPromise = provider === "openrouter"
        ? Promise.resolve(createOpenRouterEmbeddingScorer(modelId))
        : createSemanticScorer(modelId);
    }
    return scorerPromise;
  }
  const existing = scorerPromiseByKey.get(cacheKey);
  if (existing) {
    return existing;
  }
  const created = provider === "openrouter"
    ? Promise.resolve(createOpenRouterEmbeddingScorer(modelId))
    : createSemanticScorer(modelId);
  scorerPromiseByKey.set(cacheKey, created);
  return created;
}

function createOpenRouterLibrarian(modelId: string): Librarian {
  return async (input: {
  file: string;
  fileSummary: string;
  candidates: LibrarianCandidate[];
  }): Promise<LibrarianDecision> => {
  const startedAt = performance.now();
  const fallback = () => {
    const selectedDaemons = selectDaemonNamesForFile(
      input.candidates.map((candidate) => ({
        daemonName: candidate.daemonName,
        semanticScore: candidate.semanticScore,
        scoreBoost: candidate.scoreBoost,
        finalScore: candidate.finalScore,
        dependencyExact: candidate.dependencyExact,
        checkedExact: candidate.checkedExact,
        pathNeighborScore: candidate.pathNeighborScore,
        selected: false,
      })),
    );
    logRoutingDebug("librarian_fallback", {
      model: modelId,
      file: input.file,
      candidates: input.candidates.length,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      selectedDaemons,
    });
    return {
      selectedDaemons,
      rationale: "fallback librarian used score-ranked candidates",
      confidence: selectedDaemons.length > 0 ? 0.5 : 0.2,
    } satisfies LibrarianDecision;
  };

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || input.candidates.length === 0) {
    return fallback();
  }

  const { system, user } = buildLibrarianPrompt(input);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!response.ok) {
      return fallback();
    }
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return fallback();
    }
    const parsed = JSON.parse(content) as {
      selected_daemons?: unknown;
      rationale?: unknown;
      confidence?: unknown;
    };
    const allowed = new Set(input.candidates.map((candidate) => candidate.daemonName));
    const selectedDaemons = Array.isArray(parsed.selected_daemons)
      ? parsed.selected_daemons
          .filter((value): value is string => typeof value === "string" && allowed.has(value))
          .sort((a, b) => a.localeCompare(b))
      : [];
    const decision = {
      selectedDaemons,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "openrouter librarian response",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
    };
    logRoutingDebug("librarian_decision", {
      model: modelId,
      file: input.file,
      candidates: input.candidates.length,
      selectedDaemons,
      confidence: decision.confidence ?? null,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
    return decision;
  } catch {
    return fallback();
  }
  };
}

function buildLibrarianPrompt(input: {
  file: string;
  fileSummary: string;
  candidates: LibrarianCandidate[];
}): { system: string; user: string } {
  const system = [
    "You are a reusable routing librarian for daemon-based review systems.",
    "Your job is only to decide which candidate daemons should review one file.",
    "Use the provided daemon metadata, routing scores, and memory signals.",
    "Prefer narrower candidate ownership when a broad candidate is only weakly supported.",
    "It is valid to select zero, one, or many daemons.",
    "Do not audit the file. Do not suggest code changes. Do not invent candidate daemons.",
    "Return strict JSON with keys: selected_daemons, rationale, confidence.",
    "selected_daemons must be a subset of the provided candidate daemon names.",
  ].join(" ");

  const userPayload = {
    file: input.file,
    file_summary: input.fileSummary,
    candidates: input.candidates.map((candidate) => ({
      daemon_name: candidate.daemonName,
      semantic_score: Number(candidate.semanticScore.toFixed(3)),
      score_boost: Number(candidate.scoreBoost.toFixed(3)),
      final_score: Number(candidate.finalScore.toFixed(3)),
      dependency_exact: candidate.dependencyExact,
      checked_exact: candidate.checkedExact,
      path_neighbor_score: Number(candidate.pathNeighborScore.toFixed(3)),
      tracked_subjects: candidate.trackedSubjects,
      tracked_dependency_paths: candidate.trackedDependencyPaths,
      daemon_profile: candidate.profile,
    })),
  };

  return {
    system,
    user: `${JSON.stringify(userPayload, null, 2)}\n\nReturn only JSON.`,
  };
}

function scoreDaemonsForFile(
  semanticScores: SemanticScores,
  daemonProfiles: Array<{ daemonName: string; profile: string }>,
  memoryByDaemon: Map<string, DaemonRoutingMemory> | undefined,
  file: string,
): FileDaemonScore[] {
  return daemonProfiles
    .map((daemon) => {
      const semanticScore = semanticScores.get(daemon.daemonName) ?? 0;
      const signal = structuredSignalForFile(file, memoryByDaemon?.get(daemon.daemonName));
      return {
        daemonName: daemon.daemonName,
        semanticScore,
        scoreBoost: signal.scoreBoost,
        finalScore: Math.min(1, semanticScore + signal.scoreBoost),
        dependencyExact: signal.dependencyExact,
        checkedExact: signal.checkedExact,
        pathNeighborScore: signal.pathNeighborScore,
        selected: false,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

function selectDaemonNamesForFile(scores: FileDaemonScore[]): string[] {
  const threshold = routerScoreThreshold();
  const maxGap = routerScoreGap();
  const topK = routerTopK();
  const topScore = scores[0]?.finalScore ?? 0;
  if (topScore < threshold) {
    return [];
  }

  return scores
    .filter((score) => score.finalScore >= threshold && topScore - score.finalScore <= maxGap)
    .slice(0, topK)
    .map((score) => score.daemonName);
}

function buildCandidatesForMode(
  scores: FileDaemonScore[],
  daemonProfiles: Array<{ daemonName: string; profile: string }>,
  memoryByDaemon: Map<string, DaemonRoutingMemory> | undefined,
  mode: RouterMode,
): LibrarianCandidate[] {
  const profileByName = new Map(daemonProfiles.map((profile) => [profile.daemonName, profile.profile]));
  return scores
    .filter((score) => {
      if (mode === "memory_only") {
        return score.scoreBoost > 0;
      }
      if (mode === "embedding_only") {
        return score.semanticScore > 0;
      }
      return score.semanticScore > 0 || score.scoreBoost > 0;
    })
    .map((score) => ({
      daemonName: score.daemonName,
      profile: profileByName.get(score.daemonName) ?? "",
      trackedSubjects: memoryByDaemon?.get(score.daemonName)?.trackedSubjects ?? [],
      trackedDependencyPaths: memoryByDaemon?.get(score.daemonName)?.dependencyFiles ?? [],
      semanticScore: score.semanticScore,
      scoreBoost: score.scoreBoost,
      finalScore: score.finalScore,
      dependencyExact: score.dependencyExact,
      checkedExact: score.checkedExact,
      pathNeighborScore: score.pathNeighborScore,
    }))
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, routerTopK());
}

function scoresForMode(scores: FileDaemonScore[], mode: RouterMode): FileDaemonScore[] {
  if (mode === "memory_only") {
    return scores.map((score) => ({
      ...score,
      finalScore: Math.min(1, score.scoreBoost),
    }));
  }
  if (mode === "embedding_only") {
    return scores.map((score) => ({
      ...score,
      finalScore: Math.min(1, score.semanticScore),
    }));
  }
  return scores;
}

export async function evaluateRouting(
  changedFiles: string[],
  specs: DaemonSpec[],
  options: RouteDaemonsOptions = {},
): Promise<RoutingEvaluation> {
  const evaluationStartedAt = performance.now();
  const routableSpecs = specs.filter((spec) => spec.review.routingCategories.length > 0);
  if (routableSpecs.length === 0 || changedFiles.length === 0) {
    return { routedDaemons: [], fileDebug: [] };
  }

  const daemonProfiles = routableSpecs.map((spec) => ({
    daemonName: spec.name,
    profile: buildDaemonProfile(spec, {
      trackedSubjectNames: options.memoryByDaemon?.get(spec.name)?.trackedSubjects,
      trackedDependencyPaths: options.memoryByDaemon?.get(spec.name)?.dependencyFiles,
    }),
  }));
  const mode = options.modeOverride ?? routerMode();
  const semanticScorer = options.semanticScorerOverride ?? await getSemanticScorer(
    options.routerProviderOverride ?? routerProvider(),
    options.routerModelOverride ?? routerModel(),
  );
  const librarian = options.librarianOverride ?? createOpenRouterLibrarian(
    options.librarianModelOverride ?? librarianModel(),
  );
  const fileTextResolver = options.fileTextResolver ?? defaultFileTextResolver;
  const byDaemon = new Map<string, string[]>();
  const fileDebug: FileRoutingDebug[] = [];

  const totalFiles = changedFiles.length;
  for (let fileIndex = 0; fileIndex < changedFiles.length; fileIndex += 1) {
    const file = changedFiles[fileIndex]!;
    const fileStartedAt = performance.now();
    logRoutingDebug("file_start", {
      file,
      mode,
      progress: `${fileIndex + 1}/${totalFiles}`,
    });
    const fileSummary = await getChangedFileText(file, fileTextResolver);
    const semanticScores = await semanticScorer(fileSummary, daemonProfiles);
    const scoredDaemons = scoreDaemonsForFile(
      semanticScores,
      daemonProfiles,
      options.memoryByDaemon,
      file,
    );
    const modeScores = scoresForMode(scoredDaemons, mode);
    const candidates = buildCandidatesForMode(modeScores, daemonProfiles, options.memoryByDaemon, mode);
    let selectedDaemons: string[];
    let librarianRationale: string | undefined;
    let librarianConfidence: number | undefined;
    if (mode === "memory_embedding_librarian") {
      const decision = await librarian({
        file,
        fileSummary,
        candidates,
      });
      selectedDaemons = [...new Set(decision.selectedDaemons)].sort((a, b) => a.localeCompare(b));
      librarianRationale = decision.rationale;
      librarianConfidence = decision.confidence;
    } else {
      selectedDaemons = selectDaemonNamesForFile(modeScores);
    }
    const selectedSet = new Set(selectedDaemons);
    fileDebug.push({
      file,
      fileSummary,
      selectedDaemons,
      mode,
      librarianRationale,
      librarianConfidence,
      scores: modeScores.map((score) => ({
        ...score,
        selected: selectedSet.has(score.daemonName),
      })),
    });
    for (const daemonName of selectedDaemons) {
      const current = byDaemon.get(daemonName) ?? [];
      current.push(file);
      byDaemon.set(daemonName, current);
    }
    logRoutingDebug("file_routed", {
      file,
      mode,
      progress: `${fileIndex + 1}/${totalFiles}`,
      selectedDaemons,
      candidateCount: candidates.length,
      durationMs: Math.round((performance.now() - fileStartedAt) * 100) / 100,
    });
  }

  const routedDaemons = routableSpecs
    .map((spec) => ({
      name: spec.name,
      relevantFiles: uniqueSorted(byDaemon.get(spec.name) ?? []),
    }))
    .filter((entry) => entry.relevantFiles.length > 0);

  logRoutingDebug("routing_evaluation", {
    mode,
    files: changedFiles.length,
    routableDaemons: routableSpecs.length,
    routedDaemons: routedDaemons.length,
    durationMs: Math.round((performance.now() - evaluationStartedAt) * 100) / 100,
  });

  return { routedDaemons, fileDebug };
}

export async function routeDaemons(
  changedFiles: string[],
  specs: DaemonSpec[],
  options: RouteDaemonsOptions = {},
): Promise<RoutedDaemon[]> {
  const evaluation = await evaluateRouting(changedFiles, specs, options);
  return evaluation.routedDaemons;
}

export function resetRoutingCachesForTests(): void {
  scorerPromise = null;
  scorerPromiseByKey.clear();
  processEmbeddingCache.clear();
  minioEmbeddingCache = undefined;
}
