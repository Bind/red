export type Change = {
  id: string;
  title: string;
  commitSha: string;
  summary: string | null;
  summaryForSha: string | null;
  reviewers: string[];
};

export class ChangeStore {
  private readonly changes = new Map<string, Change>();

  upsert(change: Change): void {
    this.changes.set(change.id, { ...change });
  }

  get(id: string): Change | undefined {
    const c = this.changes.get(id);
    return c ? { ...c } : undefined;
  }

  list(): Change[] {
    return Array.from(this.changes.values()).map((c) => ({ ...c }));
  }

  setSummary(id: string, summary: string, forSha: string): void {
    const existing = this.changes.get(id);
    if (!existing) throw new Error(`unknown change: ${id}`);
    existing.summary = summary;
    existing.summaryForSha = forSha;
  }

  assignReviewer(id: string, reviewer: string): void {
    const existing = this.changes.get(id);
    if (!existing) throw new Error(`unknown change: ${id}`);
    if (!existing.reviewers.includes(reviewer)) {
      existing.reviewers.push(reviewer);
    }
  }

  advanceCommit(id: string, newSha: string): void {
    const existing = this.changes.get(id);
    if (!existing) throw new Error(`unknown change: ${id}`);
    existing.commitSha = newSha;
  }
}

export function seedDemoChanges(store: ChangeStore): void {
  store.upsert({
    id: "chg_001",
    title: "Add rate limiting to /v1/events",
    commitSha: "a1b2c3d",
    summary: "Adds token-bucket rate limiter to the events ingest endpoint.",
    summaryForSha: "a1b2c3d",
    reviewers: ["alice"],
  });
  store.upsert({
    id: "chg_002",
    title: "Fix flaky grs integration test",
    commitSha: "e4f5a6b",
    summary: null,
    summaryForSha: null,
    reviewers: [],
  });
  store.upsert({
    id: "chg_003",
    title: "Bump bun to 1.3.10",
    commitSha: "7c8d9e0",
    summary: "Bumps runtime and regenerates lockfile.",
    summaryForSha: "1111111",
    reviewers: ["bob"],
  });
}
