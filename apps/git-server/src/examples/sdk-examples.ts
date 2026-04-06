import { InMemoryChangeStore } from "../core/change-store";
import { MockGitSdk } from "../core/mock-git-sdk";

export async function runExample() {
  const store = new MockGitSdk({
    publicUrl: "https://git.example.redc.internal",
    defaultOwner: "redc",
  });

  const repo = await store.createRepo({
    name: "agent-scratch",
    defaultBranch: "main",
    visibility: "private",
  });

  const remote = await repo.getRemoteUrl({
    actorId: "agent-123",
    ttlSeconds: 3600,
  });

  const commit = await repo
    .createCommit({
      branch: "refs/heads/experiments/sdk-example",
      message: "Seed experiment branch",
      author: {
        name: "redc agent",
        email: "agent@redc.local",
      },
    })
    .put("README.md", "# agent-scratch\n")
    .put("src/index.ts", 'export const status = "draft";\n')
    .send();

  const diff = await repo.getCommitDiff({
    baseRef: "refs/heads/main",
    headRef: commit.branch,
  });

  const changes = new InMemoryChangeStore();
  const change = await changes.create({
    repoId: (await repo.info()).id,
    baseRef: "refs/heads/main",
    headRef: commit.branch,
    status: "draft",
  });

  return {
    repo: await repo.info(),
    remote,
    commit,
    diff,
    change,
    gitExample: [
      `git clone ${remote.fetchUrl}`,
      "cd agent-scratch",
      "git checkout -b experiments/sdk-example",
      "git add .",
      'git commit -m "Seed experiment branch"',
      `git push ${remote.pushUrl} HEAD:refs/heads/experiments/sdk-example`,
    ],
  };
}

export async function runForkedExample() {
  const store = new MockGitSdk({
    publicUrl: "https://git.example.redc.internal",
    defaultOwner: "redc",
  });

  const baseRepo = await store.createRepo({
    owner: "redc",
    name: "app",
    defaultBranch: "main",
    visibility: "private",
  });

  const agentRepo = await store.createRepo({
    owner: "agents",
    name: "app-agent-123",
    defaultBranch: "main",
    visibility: "private",
    baseRepo: {
      owner: "redc",
      name: "app",
      defaultBranch: "main",
      provider: "git",
    },
  });

  const remote = await agentRepo.getRemoteUrl({
    actorId: "agent-123",
    ttlSeconds: 3600,
  });

  const commit = await agentRepo
    .createCommit({
      branch: "refs/heads/agents/agent-123/fix-login",
      message: "Fix login redirect handling",
      author: {
        name: "redc agent",
        email: "agent@redc.local",
      },
    })
    .put("src/auth.ts", 'export const redirectMode = "strict";\n')
    .put("README.md", "# app-agent-123\n")
    .send();

  const diff = await agentRepo.getCommitDiff({
    baseRef: "refs/heads/main",
    headRef: commit.branch,
  });

  const changes = new InMemoryChangeStore();
  const change = await changes.create({
    repoId: (await baseRepo.info()).id,
    headRepoId: (await agentRepo.info()).id,
    baseRef: "refs/heads/main",
    headRef: commit.branch,
    status: "draft",
  });

  return {
    baseRepo: await baseRepo.info(),
    headRepo: await agentRepo.info(),
    remote,
    commit,
    diff,
    change,
    gitExample: [
      `git clone ${remote.fetchUrl}`,
      "cd app-agent-123",
      "git checkout -b agents/agent-123/fix-login",
      "git add .",
      'git commit -m "Fix login redirect handling"',
      `git push ${remote.pushUrl} HEAD:refs/heads/agents/agent-123/fix-login`,
      "# redc then opens a review from redc/app:refs/heads/main to agents/app-agent-123:refs/heads/agents/agent-123/fix-login",
    ],
  };
}
