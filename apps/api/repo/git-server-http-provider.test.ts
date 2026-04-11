import { describe, expect, test } from "bun:test";
import { GitServerHttpRepositoryProvider } from "./git-server-http-provider";

describe("GitServerHttpRepositoryProvider", () => {
  test("reads branches, commits, files, compare, and repo metadata from git-server control plane", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers?.get("authorization") ?? null });

      if (url.endsWith("/api/repos/redc/redc")) {
        return Response.json({
          id: "redc/redc",
          name: "redc",
          full_name: "redc/redc",
          default_branch: "main",
        });
      }
      if (url.endsWith("/api/repos/redc/redc/branches")) {
        return Response.json([
          {
            name: "main",
            commit: {
              id: "abc",
              message: "init",
              timestamp: "2026-01-01T00:00:00Z",
            },
            protected: true,
          },
        ]);
      }
      if (url.includes("/api/repos/redc/redc/commits")) {
        if (url.includes("/diff")) {
          return Response.json({
            patch: "diff --git a/src/app.ts b/src/app.ts",
          });
        }
        return Response.json([
          {
            sha: "abc",
            message: "init",
            author_name: "redc",
            author_email: "redc@example.com",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (url.includes("/api/repos/redc/redc/file")) {
        return Response.json({
          path: "README.md",
          ref: "main",
          content: "# redc\n",
        });
      }
      if (url.includes("patch=1")) {
        return Response.json({
          files_changed: 1,
          additions: 3,
          deletions: 1,
          files: [
            {
              filename: "README.md",
              additions: 3,
              deletions: 1,
              status: "modified",
            },
          ],
          patch: "diff --git a/README.md b/README.md",
        });
      }
      if (url.includes("/api/repos/redc/redc/compare")) {
        return Response.json({
          files_changed: 1,
          additions: 3,
          deletions: 1,
          files: [
            {
              filename: "README.md",
              additions: 3,
              deletions: 1,
              status: "modified",
            },
          ],
        });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const provider = new GitServerHttpRepositoryProvider({
        baseUrl: "http://git-server:8080",
        username: "admin",
        password: "admin",
      });

      expect(await provider.getRepo?.("redc", "redc")).toMatchObject({
        full_name: "redc/redc",
        default_branch: "main",
      });
      expect(await provider.listBranches?.("redc", "redc")).toHaveLength(1);
      expect(await provider.listCommits?.("redc", "redc", "main", 10)).toHaveLength(1);
      expect(await provider.getCommitDiff?.("redc", "redc", "abc")).toContain("diff --git");
      expect(await provider.getFileContent("redc", "redc", "README.md", "main")).toContain("redc");
      expect(await provider.compareDiff("redc", "redc", "main", "feature/demo")).toMatchObject({
        files_changed: 1,
        additions: 3,
      });
      expect(await provider.getDiff("redc", "redc", "main", "feature/demo")).toContain("diff --git");

      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => typeof call.auth === "string" && call.auth.startsWith("Basic "))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
