import { expect, test } from "bun:test";
import { GitHubRepo } from "./repo";

test("GitHubRepo embeds token in fetchUrl using x-access-token Basic auth", async () => {
  const repo = new GitHubRepo({
    owner: "Bind",
    name: "red",
    token: "ghs_super_secret",
  });

  const remote = await repo.getReadRemote("refs/heads/main");

  expect(remote.fetchUrl).toBe("https://x-access-token:ghs_super_secret@github.com/Bind/red.git");
  expect(remote.gitConfigArgs).toBeUndefined();
});

test("GitHubRepo omits credentials when no token is provided", async () => {
  const repo = new GitHubRepo({ owner: "Bind", name: "red" });
  const remote = await repo.getReadRemote("refs/heads/main");
  expect(remote.fetchUrl).toBe("https://github.com/Bind/red.git");
  expect(remote.gitConfigArgs).toBeUndefined();
});
