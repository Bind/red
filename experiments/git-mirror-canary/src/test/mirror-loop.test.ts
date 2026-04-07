import { describe, expect, test } from "bun:test";
import { MirrorLoopService } from "../service/mirror-loop";
import type {
  CanaryConfig,
  CanaryEvent,
  Clock,
  MirrorEventPublisher,
  MirrorGitClient,
  MirrorRepoConfig,
  MirrorStateStore,
  RepoStatusRecord,
} from "../util/types";

class InMemoryStore implements MirrorStateStore {
  readonly statuses = new Map<string, RepoStatusRecord>();
  readonly events: CanaryEvent[] = [];

  init() {}

  getRepoStatus(repoId: string) {
    return this.statuses.get(repoId) ?? null;
  }

  upsertRepoStatus(record: RepoStatusRecord) {
    this.statuses.set(record.repoId, record);
  }

  appendEvent(event: CanaryEvent) {
    this.events.push(event);
  }

  listRepoStatuses() {
    return [...this.statuses.values()];
  }

  listEvents(limit: number) {
    return this.events.slice(-limit).reverse();
  }
}

class RecordingPublisher implements MirrorEventPublisher {
  readonly delivered: CanaryEvent[] = [];

  async publish(event: CanaryEvent) {
    this.delivered.push(event);
  }
}

class FakeClock implements Clock {
  constructor(private readonly value: string) {}

  now() {
    return new Date(this.value);
  }
}

class FakeGitClient implements MirrorGitClient {
  runs = 0;

  constructor(
    private readonly sourceHead: string,
    private readonly targetHead: string,
    private readonly shouldFail = false,
  ) {}

  async ensureLocalMirror(_repo: MirrorRepoConfig, _cacheDir: string) {
    this.runs += 1;
    return "/tmp/cache/repo.git";
  }

  async resolveLocalRef(_cachePath: string, _ref: string) {
    return this.sourceHead;
  }

  async pushMirror(_cachePath: string, _repo: MirrorRepoConfig) {
    if (this.shouldFail) {
      throw new Error("push failed");
    }
  }

  async resolveRemoteRef(_repo: MirrorRepoConfig) {
    return this.targetHead;
  }
}

function config(repos: MirrorRepoConfig[]): CanaryConfig {
  return {
    mode: "dev",
    hostname: "127.0.0.1",
    port: 4080,
    pollIntervalMs: 1000,
    dataDir: "/tmp/data",
    cacheDir: "/tmp/cache",
    stateDbPath: "/tmp/state.sqlite",
    repos,
  };
}

describe("MirrorLoopService", () => {
  test("records successful mirror runs and source advancement", async () => {
    const store = new InMemoryStore();
    store.upsertRepoStatus({
      repoId: "github/git",
      trackedRef: "refs/heads/main",
      lastRunStatus: "success",
      lastSourceHead: "oldsha",
      lastTargetHead: "oldsha",
      lastRunAt: "2026-01-01T00:00:00.000Z",
      lastSuccessAt: "2026-01-01T00:00:00.000Z",
      consecutiveFailures: 0,
    });
    const publisher = new RecordingPublisher();
    const service = new MirrorLoopService(
      config([
        {
          id: "github/git",
          sourceUrl: "https://github.com/git/git.git",
          targetUrl: "https://git.internal/redc/git.git",
          trackedRef: "refs/heads/main",
        },
      ]),
      store,
      new FakeGitClient("newsha", "newsha"),
      publisher,
      new FakeClock("2026-04-07T12:00:00.000Z"),
    );

    await service.runOnce();

    expect(store.getRepoStatus("github/git")).toMatchObject({
      lastRunStatus: "success",
      lastSourceHead: "newsha",
      lastTargetHead: "newsha",
      consecutiveFailures: 0,
    });
    expect(store.events.map((event) => event.type)).toEqual([
      "source_advanced",
      "mirror_succeeded",
    ]);
    expect(publisher.delivered).toHaveLength(2);
  });

  test("records issue events on mirror failure", async () => {
    const store = new InMemoryStore();
    const publisher = new RecordingPublisher();
    const service = new MirrorLoopService(
      config([
        {
          id: "github/git",
          sourceUrl: "https://github.com/git/git.git",
          targetUrl: "https://git.internal/redc/git.git",
          trackedRef: "refs/heads/main",
        },
      ]),
      store,
      new FakeGitClient("newsha", "newsha", true),
      publisher,
      new FakeClock("2026-04-07T12:00:00.000Z"),
    );

    await service.runOnce();

    expect(store.getRepoStatus("github/git")).toMatchObject({
      lastRunStatus: "error",
      consecutiveFailures: 1,
    });
    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.type).toBe("mirror_issue");
    expect(publisher.delivered[0]?.severity).toBe("error");
  });

  test("skips repos that are not yet due unless explicitly requested", async () => {
    const store = new InMemoryStore();
    store.upsertRepoStatus({
      repoId: "github/git",
      trackedRef: "refs/heads/main",
      lastRunStatus: "success",
      lastSourceHead: "sha",
      lastTargetHead: "sha",
      lastRunAt: "2026-04-07T12:00:00.000Z",
      lastSuccessAt: "2026-04-07T12:00:00.000Z",
      consecutiveFailures: 0,
    });
    const publisher = new RecordingPublisher();
    const git = new FakeGitClient("newsha", "newsha");
    const service = new MirrorLoopService(
      config([
        {
          id: "github/git",
          sourceUrl: "https://github.com/git/git.git",
          targetUrl: "https://git.internal/redc/git.git",
          trackedRef: "refs/heads/main",
          pollIntervalMs: 60_000,
        },
      ]),
      store,
      git,
      publisher,
      new FakeClock("2026-04-07T12:00:10.000Z"),
    );

    await service.runOnce();
    expect(git.runs).toBe(0);

    await service.runOnce(["github/git"]);
    expect(git.runs).toBe(1);
  });
});
