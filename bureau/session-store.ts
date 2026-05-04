import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PiSessionSnapshot = {
  version: 1;
  systemPrompt: string;
  messages: unknown[];
};

export type BureauSessionMeta = {
  sessionId: string;
  parentSessionId: string | null;
  agentName: string;
  args: unknown;
  mode: string | null;
  sourceSha: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BureauStoredSession = {
  snapshot: PiSessionSnapshot;
  meta: BureauSessionMeta;
};

export type BureauSessionStore = {
  createRoot(input: {
    sessionId?: string;
    agentName: string;
    args: unknown;
    mode?: string | null;
    sourceSha?: string | null;
    snapshot: PiSessionSnapshot;
  }): Promise<BureauStoredSession>;
  get(sessionId: string): Promise<BureauStoredSession | null>;
  list(filter?: {
    agentName?: string;
    parentSessionId?: string | null;
    mode?: string | null;
  }): Promise<BureauSessionMeta[]>;
};

export function createLocalBureauSessionStore(input: {
  rootDir: string;
}): BureauSessionStore {
  const sessionsRoot = join(input.rootDir, ".bureau", "sessions");

  return {
    async createRoot({ sessionId = createBureauSessionId(), agentName, args, mode = null, sourceSha = null, snapshot }) {
      const timestamp = new Date().toISOString();
      const meta: BureauSessionMeta = {
        sessionId,
        parentSessionId: null,
        agentName,
        args,
        mode,
        sourceSha,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const dir = join(sessionsRoot, sessionId);

      await mkdir(dir, { recursive: true });
      await writeJson(join(dir, "session.json"), snapshot);
      await writeJson(join(dir, "meta.json"), meta);

      return { snapshot, meta };
    },

    async get(sessionId) {
      const dir = join(sessionsRoot, sessionId);
      try {
        const [snapshot, meta] = await Promise.all([
          readJson<PiSessionSnapshot>(join(dir, "session.json")),
          readJson<BureauSessionMeta>(join(dir, "meta.json")),
        ]);
        return { snapshot, meta };
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
    },

    async list(filter = {}) {
      let entries: Array<{ name: string; isDirectory(): boolean }> = [];
      try {
        entries = (await readdir(sessionsRoot, { withFileTypes: true })).map((entry) => ({
          name: String(entry.name),
          isDirectory: () => entry.isDirectory(),
        }));
      } catch (error) {
        if (isMissingFileError(error)) return [];
        throw error;
      }

      const metas = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => readJson<BureauSessionMeta>(join(sessionsRoot, entry.name, "meta.json"))),
      );

      return metas.filter((meta) => {
        if (filter.agentName !== undefined && meta.agentName !== filter.agentName) return false;
        if (
          filter.parentSessionId !== undefined &&
          meta.parentSessionId !== filter.parentSessionId
        ) {
          return false;
        }
        if (filter.mode !== undefined && meta.mode !== filter.mode) return false;
        return true;
      });
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function createBureauSessionId(): string {
  return `${encodeTime(Date.now())}${randomBase32(16)}`;
}

function encodeTime(value: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let remaining = value;
  let output = "";
  do {
    output = alphabet[remaining % 32] + output;
    remaining = Math.floor(remaining / 32);
  } while (remaining > 0);
  return output.padStart(10, "0");
}

function randomBase32(length: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let output = "";
  for (const byte of bytes) output += alphabet[byte % 32];
  return output;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
