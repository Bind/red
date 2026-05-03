import { expect, test } from "bun:test";
import { GitHubRepo } from "./repo";

test("GitHubRepo keeps tokens out of fetchUrl and exposes auth via git config args", async () => {
  const repo = new GitHubRepo({
    owner: "Bind",
    name: "red",
    token: "ghs_super_secret",
  });

  const remote = await repo.getReadRemote("refs/heads/main");

  expect(remote.fetchUrl).toBe("https://github.com/Bind/red.git");
  expect(remote.fetchUrl).not.toContain("ghs_super_secret");
  expect(remote.gitConfigArgs).toEqual([
    "-c",
    "http.extraHeader=AUTHORIZATION: bearer ghs_super_secret",
  ]);
});
