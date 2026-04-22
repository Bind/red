import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { refreshOpenAICodexToken } from "@mariozechner/pi-ai/oauth";

/**
 * Pluggable source of Codex OAuth credentials. Red will eventually ship its
 * own implementation that draws from its secret store; the default reads the
 * well-known `~/.codex/auth.json` written by the `codex login` CLI.
 */
export interface CodexAuthSource {
  /** Return current credentials. Implementations may cache. */
  load(): Promise<OAuthCredentials>;
  /** Persist updated credentials after a refresh. Optional. */
  save?(credentials: OAuthCredentials): Promise<void>;
}

export class CodexAccessTokenManager {
  private cached?: OAuthCredentials;

  constructor(private readonly source: CodexAuthSource) {}

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    let current = this.cached ?? (await this.source.load());
    if (current.expires <= now + 60_000) {
      current = await refreshOpenAICodexToken(current.refresh);
      await this.source.save?.(current);
    }
    this.cached = current;
    return current.access;
  }

  /** Clear the cached token so the next call reloads from the source. */
  invalidate(): void {
    this.cached = undefined;
  }
}

type CodexAuthFile = {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string | null;
  };
  last_refresh?: string;
};

export function createFileCodexAuthSource(path?: string): CodexAuthSource {
  const authPath = path ?? join(homedir(), ".codex", "auth.json");
  return {
    async load() {
      const raw = await readFile(authPath, "utf8");
      const parsed = JSON.parse(raw) as CodexAuthFile;
      const access = parsed.tokens?.access_token;
      const refresh = parsed.tokens?.refresh_token;
      if (!access || !refresh) {
        throw new Error(
          `no codex OAuth tokens found at ${authPath}. Run \`codex login\` (ChatGPT subscription) first.`,
        );
      }
      const expires = parsed.last_refresh
        ? Date.parse(parsed.last_refresh) + 25 * 60 * 1000
        : Date.now() + 60 * 1000;
      return { access, refresh, expires };
    },
    async save(credentials) {
      const raw = await readFile(authPath, "utf8").catch(() => "{}");
      const parsed = (JSON.parse(raw) || {}) as CodexAuthFile;
      parsed.tokens = {
        ...(parsed.tokens ?? {}),
        access_token: credentials.access,
        refresh_token: credentials.refresh,
      };
      parsed.last_refresh = new Date().toISOString();
      await writeFile(authPath, JSON.stringify(parsed, null, 2));
    },
  };
}

export function createInMemoryCodexAuthSource(
  credentials: OAuthCredentials,
): CodexAuthSource {
  let current = { ...credentials };
  return {
    async load() {
      return { ...current };
    },
    async save(next) {
      current = { ...next };
    },
  };
}
