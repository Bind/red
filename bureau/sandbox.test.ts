import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { startWorkflowObserver } from "./observability";
import { LocalRepo } from "./repo";
import { sandbox } from "./sandbox";

const skipIfNoGit = process.env.SKIP_BUREAU_SANDBOX_TESTS === "1";

test.skipIf(skipIfNoGit)("just-bash sandbox emits lifecycle events through observer", async () => {
  const observer = startWorkflowObserver({
    workflowName: "test-sandbox",
    runId: "run_sandbox_lifecycle",
    sinks: [],
  });

  const sb = await sandbox.justBash().create({ preserve: false, observer });
  expect(sb.exposedRoot).toBeTruthy();

  await sb.cleanup();

  const kinds = observer.drain().map((e) => e.kind);
  expect(kinds).toContain("sandbox.created");
  expect(kinds).toContain("sandbox.cleaned_up");
});

test.skipIf(skipIfNoGit)("just-bash sandbox emits sandbox.preserved instead of cleanup when preserve=true", async () => {
  const observer = startWorkflowObserver({
    workflowName: "test-sandbox",
    runId: "run_sandbox_preserve",
    sinks: [],
  });

  const sb = await sandbox.justBash().create({ preserve: true, observer });
  await sb.cleanup();
  await rm(sb.root, { recursive: true, force: true });

  const kinds = observer.drain().map((e) => e.kind);
  expect(kinds).toContain("sandbox.preserved");
  expect(kinds).not.toContain("sandbox.cleaned_up");
});

test.skipIf(skipIfNoGit)("clone failure emits sandbox.clone.failed", async () => {
  const observer = startWorkflowObserver({
    workflowName: "test-sandbox",
    runId: "run_sandbox_clone_fail",
    sinks: [],
  });

  const sb = await sandbox.justBash().create({ preserve: false, observer });
  const repo = new LocalRepo({ root: "/nonexistent/path/that/should/not/exist" });

  await expect(
    sb.clone({ repo, ref: "refs/heads/main", dest: "trunk", role: "trunk" }),
  ).rejects.toThrow();

  await sb.cleanup();

  const events = observer.drain();
  const cloneFailed = events.find((e) => e.kind === "sandbox.clone.failed");
  expect(cloneFailed).toBeDefined();
  expect(cloneFailed?.data).toMatchObject({
    role: "trunk",
    dest: "trunk",
  });
});
