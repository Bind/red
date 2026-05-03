import type { CompleteFinding } from "../../../../pkg/daemons/src/index";
import type { WideEvent } from "../../../../pkg/daemons/src/wide-events";
import type { DaemonSpec } from "../../../../pkg/daemons/src/index";
import type { Librarian, RoutedDaemon, RoutingEvaluation } from "./routing";
import type { DaemonClassified } from "./proposals";
import type { DaemonRoutingMemory } from "./routing-memory";
import type { RouterProvider } from "./routing";

export type DaemonOutcome = {
  name: string;
  ok: boolean;
  runId: string;
  summary: string;
  findings: CompleteFinding[];
  wideEvents: WideEvent[];
  turns: number;
  tokens: { input: number; output: number };
  viewedFiles: string[];
  changedFiles: string[];
  initialMemory: InitialMemoryShape | null;
  reason?: string;
  message?: string;
  diff: string;
};

export type DaemonReviewConfig = {
  maxTurns: number;
};

export type GithubPrContext = {
  owner: string;
  repo: string;
  prNumber: number;
  githubToken: string;
  prBaseSha: string;
  prBaseRef: string;
  prHeadSha: string;
  prHeadRef: string;
  prHeadRepoFullName: string;
};

export type DaemonRunPlan = {
  changedFiles: string[];
  specs: DaemonSpec[];
  routedDaemons: RoutedDaemon[];
};

export type ReviewExecutionContext = {
  trustedRoot: string;
  reviewRoot: string;
  changedFiles: string[];
  daemonName?: string;
  daemonLimit?: number;
  librarianOverride?: Librarian;
};

export type ReviewPreparedContext = {
  trustedRoot: string;
  reviewRoot: string;
  specs: DaemonSpec[];
  specByName: Map<string, DaemonSpec>;
  memoryByDaemon: Map<string, DaemonRoutingMemory>;
};

export type ReviewRoutingContext = {
  changedFiles: string[];
  daemonName?: string;
  daemonLimit?: number;
  librarianOverride: Librarian;
  routerProvider: RouterProvider;
  routerModel: string;
};

export type ReviewRoutingResult = {
  evaluation: RoutingEvaluation;
  routedDaemons: RoutedDaemon[];
};

export type ProposalArtifacts = {
  edits: DaemonEditArtifact[];
  classifications?: DaemonClassified[];
};

export type DaemonEditArtifact = {
  daemonName: string;
  diff: string;
  filesTouched: string[];
};

export type InitialMemoryShape = {
  snapshotCommit: string | null;
  currentCommit: string | null;
  previousSummary: string;
  trackedSubjects: string[];
  staleTrackedSubjects: string[];
  checkedFiles: string[];
  changedFiles: string[];
  newFiles: string[];
  missingFiles: string[];
  changedScopeFiles: string[];
};

export type ReviewExecutionResult = {
  changedFiles: string[];
  specs: DaemonSpec[];
  routedDaemons: RoutedDaemon[];
  outcomes: DaemonOutcome[];
  summary: string;
  blockingFailures: DaemonOutcome[];
  proposalArtifacts: ProposalArtifacts | null;
};

export type DaemonReviewResult = {
  summary: string;
  outcomes: DaemonOutcome[];
  blockingFailures: DaemonOutcome[];
  proposalArtifacts?: ProposalArtifacts | null;
};
