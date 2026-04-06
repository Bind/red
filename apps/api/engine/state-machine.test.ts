import { describe, test, expect, beforeEach } from "bun:test";
import { initInMemoryDatabase } from "../db/schema";
import { ChangeQueries, EventQueries } from "../db/queries";
import { ChangeStateMachine, InvalidTransitionError } from "./state-machine";
import type { Database } from "bun:sqlite";

let db: Database;
let changes: ChangeQueries;
let events: EventQueries;
let sm: ChangeStateMachine;

beforeEach(() => {
  db = initInMemoryDatabase();
  changes = new ChangeQueries(db);
  events = new EventQueries(db);
  sm = new ChangeStateMachine(changes, events);
});

const makeChange = () =>
  changes.create({
    org_id: "default",
    repo: "owner/repo",
    branch: "feat",
    base_branch: "main",
    head_sha: "abc",
    created_by: "human",
    delivery_id: `d-${Math.random()}`,
  });

describe("ChangeStateMachine", () => {
  test("valid transition: pushed → scoring", () => {
    const c = makeChange();
    sm.transition(c.id, "scoring");
    expect(changes.getById(c.id)!.status).toBe("scoring");

    const evts = events.listByChangeId(c.id);
    expect(evts).toHaveLength(1);
    expect(evts[0].event_type).toBe("status_change");
    expect(evts[0].from_status).toBe("pushed");
    expect(evts[0].to_status).toBe("scoring");
  });

  test("full happy path: pushed → ready_for_review", () => {
    const c = makeChange();
    sm.transition(c.id, "scoring");
    sm.transition(c.id, "scored");
    sm.transition(c.id, "summarizing");
    sm.transition(c.id, "ready_for_review");

    expect(changes.getById(c.id)!.status).toBe("ready_for_review");
    expect(events.listByChangeId(c.id)).toHaveLength(4);
  });

  test("invalid transition throws InvalidTransitionError", () => {
    const c = makeChange();
    expect(() => sm.transition(c.id, "merged")).toThrow(InvalidTransitionError);
  });

  test("superseded from any non-terminal state", () => {
    const c = makeChange();
    sm.transition(c.id, "scoring");
    sm.transition(c.id, "superseded");
    expect(changes.getById(c.id)!.status).toBe("superseded");
  });

  test("cannot transition from terminal states", () => {
    const c = makeChange();
    sm.transition(c.id, "scoring");
    sm.transition(c.id, "scored");
    sm.transition(c.id, "summarizing");
    sm.transition(c.id, "ready_for_review");

    expect(() => sm.transition(c.id, "pushed")).toThrow(InvalidTransitionError);
  });

  test("transition with metadata stores it in event", () => {
    const c = makeChange();
    sm.transition(c.id, "scoring", { scorer: "v1", reason: "auto" });
    const evts = events.listByChangeId(c.id);
    const meta = JSON.parse(evts[0].metadata!);
    expect(meta.scorer).toBe("v1");
  });

  test("transition on nonexistent change throws", () => {
    expect(() => sm.transition(99999, "scoring")).toThrow("Change 99999 not found");
  });

  test("canTransition returns correct values", () => {
    expect(sm.canTransition("pushed", "scoring")).toBe(true);
    expect(sm.canTransition("pushed", "merged")).toBe(false);
    expect(sm.canTransition("ready_for_review", "summarizing")).toBe(true);
    expect(sm.canTransition("ready_for_review", "superseded")).toBe(true);
  });

  test("supersedePrior delegates correctly", () => {
    const c1 = makeChange();
    const c2 = changes.create({
      org_id: "default",
      repo: "owner/repo",
      branch: "feat",
      base_branch: "main",
      head_sha: "def",
      created_by: "human",
      delivery_id: `d-${Math.random()}`,
    });

    const count = sm.supersedePrior("owner/repo", "feat", c2.id);
    expect(count).toBe(1);
    expect(changes.getById(c1.id)!.status).toBe("superseded");
  });
});
