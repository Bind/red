import { describe, test, expect, mock, beforeEach } from "bun:test";
import { parseGitHubRemote, fetchGitHubKeys, bootstrapCommand } from "./bootstrap";
import type { CliContext } from "./index";

// ── Unit tests: parseGitHubRemote ────────────────────────

describe("parseGitHubRemote", () => {
  test("parses SSH format", () => {
    const result = parseGitHubRemote("git@github.com:alice/my-repo.git");
    expect(result).toEqual({ username: "alice", repoName: "my-repo" });
  });

  test("parses HTTPS format", () => {
    const result = parseGitHubRemote("https://github.com/bob/cool-project.git");
    expect(result).toEqual({ username: "bob", repoName: "cool-project" });
  });

  test("parses HTTPS without .git", () => {
    const result = parseGitHubRemote("https://github.com/carol/thing");
    expect(result).toEqual({ username: "carol", repoName: "thing" });
  });

  test("returns null for non-GitHub URL", () => {
    expect(parseGitHubRemote("git@gitlab.com:user/repo.git")).toBeNull();
    expect(parseGitHubRemote("https://bitbucket.org/user/repo.git")).toBeNull();
    expect(parseGitHubRemote("not-a-url")).toBeNull();
  });

  test("parses SSH format without .git suffix", () => {
    const result = parseGitHubRemote("git@github.com:dave/repo");
    expect(result).toEqual({ username: "dave", repoName: "repo" });
  });
});

// ── Integration tests: bootstrapCommand ──────────────────

describe("bootstrapCommand", () => {
  const ctx: CliContext = {
    apiUrl: "http://localhost:3000",
    format: "text",
    args: ["bootstrap"],
  };

  test("returns 1 when env vars are missing", async () => {
    const origUrl = process.env.FORGEJO_URL;
    const origToken = process.env.FORGEJO_TOKEN;
    const origSecret = process.env.WEBHOOK_SECRET;

    delete process.env.FORGEJO_URL;
    delete process.env.FORGEJO_TOKEN;
    delete process.env.WEBHOOK_SECRET;

    const code = await bootstrapCommand(ctx);
    expect(code).toBe(1);

    // Restore
    if (origUrl) process.env.FORGEJO_URL = origUrl;
    if (origToken) process.env.FORGEJO_TOKEN = origToken;
    if (origSecret) process.env.WEBHOOK_SECRET = origSecret;
  });
});
