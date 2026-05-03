import { githubContextFromEnv, runGithubDaemonReview } from "./github";

export async function runDaemonReviewFromEnv(): Promise<void> {
  const result = await runGithubDaemonReview(githubContextFromEnv());
  if (result.blockingFailures.length > 0) {
    process.exit(1);
  }
}
