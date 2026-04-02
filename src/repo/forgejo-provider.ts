import type { ForgejoClient } from "../forgejo/client";
import type { RepositoryProvider } from "./repository-provider";
import type {
  CreateExternalReviewInput,
  ExternalReviewRef,
  ReviewHostProvider,
} from "../review/review-host-provider";

export class ForgejoRepositoryProvider implements RepositoryProvider, ReviewHostProvider {
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

  publishStatus(owner: string, repo: string, sha: string, status: Parameters<ForgejoClient["setCommitStatus"]>[3]) {
    return this.client.setCommitStatus(owner, repo, sha, status);
  }

  async findOpenReviewForBranch(owner: string, repo: string, branch: string): Promise<ExternalReviewRef | null> {
    const prs = await this.client.listPRsForBranch(owner, repo, branch);
    const pr = prs[0];
    if (!pr) return null;
    return {
      providerRef: String(pr.number),
      state: pr.state,
      merged: pr.merged,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
    };
  }

  async createExternalReview(
    input: CreateExternalReviewInput
  ): Promise<ExternalReviewRef> {
    const pr = await this.client.createPR(input.owner, input.repo, {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
    });
    return {
      providerRef: String(pr.number),
      state: pr.state,
      merged: pr.merged,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
    };
  }

  mergeExternalReview(
    owner: string,
    repo: string,
    providerRef: string
  ) {
    return this.client.mergePR(owner, repo, parseInt(providerRef, 10), "merge");
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
