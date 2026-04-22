export type Issue = {
  id: string;
  title: string;
  openedAt: Date;
  labels: string[];
  comments: string[];
};

export class IssueStore {
  private readonly issues = new Map<string, Issue>();

  upsert(issue: Issue): void {
    this.issues.set(issue.id, {
      ...issue,
      labels: [...issue.labels],
      comments: [...issue.comments],
    });
  }

  get(id: string): Issue | undefined {
    const i = this.issues.get(id);
    return i ? { ...i, labels: [...i.labels], comments: [...i.comments] } : undefined;
  }

  list(): Issue[] {
    return Array.from(this.issues.values()).map((i) => ({
      ...i,
      labels: [...i.labels],
      comments: [...i.comments],
    }));
  }

  addLabel(id: string, label: string): void {
    const existing = this.issues.get(id);
    if (!existing) throw new Error(`unknown issue: ${id}`);
    if (!existing.labels.includes(label)) {
      existing.labels.push(label);
    }
  }

  addComment(id: string, body: string): void {
    const existing = this.issues.get(id);
    if (!existing) throw new Error(`unknown issue: ${id}`);
    existing.comments.push(body);
  }
}

export function seedDemoIssues(store: IssueStore, now: Date): void {
  const day = 24 * 60 * 60 * 1000;
  store.upsert({
    id: "iss_101",
    title: "Dashboard 500 on /repos page",
    openedAt: new Date(now.getTime() - 12 * day),
    labels: [],
    comments: [],
  });
  store.upsert({
    id: "iss_102",
    title: "Typo in onboarding email",
    openedAt: new Date(now.getTime() - 2 * day),
    labels: [],
    comments: [],
  });
  store.upsert({
    id: "iss_103",
    title: "Flaky CI on bun 1.3",
    openedAt: new Date(now.getTime() - 30 * day),
    labels: ["ci"],
    comments: ["already tracked in #99"],
  });
}
