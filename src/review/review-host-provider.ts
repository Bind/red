import type { ForgejoCommitStatus } from "../types";

export interface ExternalReviewRef {
  providerRef: string;
  state: "open" | "closed";
  merged: boolean;
  headRef: string;
  baseRef: string;
}

export interface CreateExternalReviewInput {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
}

export interface ReviewHostProvider {
  publishStatus?(
    owner: string,
    repo: string,
    sha: string,
    status: ForgejoCommitStatus
  ): Promise<void>;
  findOpenReviewForBranch?(
    owner: string,
    repo: string,
    branch: string
  ): Promise<ExternalReviewRef | null>;
  createExternalReview?(
    input: CreateExternalReviewInput
  ): Promise<ExternalReviewRef>;
  mergeExternalReview?(
    owner: string,
    repo: string,
    providerRef: string
  ): Promise<void>;
}
