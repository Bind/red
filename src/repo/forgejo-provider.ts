import type { ForgejoClient } from "../forgejo/client";
import type { RepositoryProvider } from "./repository-provider";

export class ForgejoRepositoryProvider implements RepositoryProvider {
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
