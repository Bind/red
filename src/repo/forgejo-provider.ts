import type { ForgejoClient } from "../forgejo/client";
import type { RepoProvider } from "./provider";

export class ForgejoRepoProvider implements RepoProvider {
  constructor(private client: ForgejoClient) {}

  compareDiff(owner: string, repo: string, base: string, head: string) {
    return this.client.compareDiff(owner, repo, base, head);
  }

  getDiff(owner: string, repo: string, base: string, head: string) {
    return this.client.getDiff(owner, repo, base, head);
  }

  getFileContent(owner: string, repo: string, filepath: string, ref: string) {
    return this.client.getFileContent(owner, repo, filepath, ref);
  }

  setCommitStatus(owner: string, repo: string, sha: string, status: Parameters<ForgejoClient["setCommitStatus"]>[3]) {
    return this.client.setCommitStatus(owner, repo, sha, status);
  }

  listPRsForBranch(owner: string, repo: string, branch: string) {
    return this.client.listPRsForBranch(owner, repo, branch);
  }

  createPR(
    owner: string,
    repo: string,
    opts: Parameters<ForgejoClient["createPR"]>[2]
  ) {
    return this.client.createPR(owner, repo, opts);
  }

  mergePR(
    owner: string,
    repo: string,
    prNumber: number,
    method: "merge" | "rebase" | "squash" = "merge"
  ) {
    return this.client.mergePR(owner, repo, prNumber, method);
  }

  listRepos() {
    return this.client.listRepos();
  }

  getRepo(owner: string, repo: string) {
    return this.client.getRepo(owner, repo);
  }

  listBranches(owner: string, repo: string) {
    return this.client.listBranches(owner, repo);
  }
}
