// TODO(#73): Remote-container Sandbox adapter — Pi-in-Docker (or Podman).
//
// This file ships as a typed stub so consumers can target the final shape.
// The actual container plumbing closes in a follow-up session where Docker
// is available. Closing this issue means landing every item below as real
// code with green tests against a live Docker daemon:
//
//   1. Container based on the existing OCR Dockerfile, lifted to
//      `bureau/runtime-image/`, with bureau source baked in (or mounted)
//      *instead of* opencode-ai. Reference: `apps/ocr/Dockerfile`,
//      `apps/ocr/run.sh`.
//
//   2. Pi runs *inside* the container. Tools (read/bash/track/complete)
//      are pure in-container code — no wire protocol. The host invokes
//      "run agent <name> with input X"; the container resolves
//      `bureau/agents/<name>/agent.ts`.
//
//   3. Events stream out via stdout/stderr.
//
//   4. Container labels carried forward for ops visibility:
//      `red.run_id`, `red.session_id`, plus session/turn/agent/repo/refs.
//      Reference: `apps/ctl/claw/runner.ts:124`–`153`.
//
//   5. Docker preflight as adapter health checks before `Bun.spawn`:
//      disk-space threshold, `docker info`, `docker image inspect`,
//      ephemeral-create probe. Reference:
//      `apps/ctl/claw/runner.ts:392`–`452`.
//
//   6. Orphan reconciliation: small sweep matching live containers (by
//      `red.session_id` label) against Sessions whose latest snapshot
//      says "running"; mark missing ones failed. Smaller than
//      `apps/ctl/claw/reconcile.ts` thanks to `await using`, but a real
//      sweep is still required.
//
//   7. Workspace persistence: when `workspaceRepo` is set on
//      createSandbox, the container clones the scratch ref into its
//      working dir before the agent loop and pushes any edits back at
//      close. Reuses `seedWorkspace` / `commitWorkspace` from
//      `bureau/workspace-persistence.ts`.
//
//   8. Integration test: open Sandbox via remote-container, run an
//      Agent, close. Reopen with same `sessionId`, run another Agent,
//      prior edits visible. Snapshot reflects two Turns.
//
//   9. Crash test: kill a container mid-`.run()`, run the orphan sweep,
//      Session is marked failed and the workspace ref is preserved if
//      the agent committed any edits.
//
//  10. Preflight test: simulate missing image / unreachable daemon /
//      low disk, adapter surfaces a typed error before spawning.
//
//  Podman is the same shape — same adapter, different command. Either
//  ship together or behind a `runtime: "docker" | "podman"` knob; no
//  wire-protocol change.

import type {
  BureauSandboxPrepareOptions,
  BureauSandboxProvider,
  BureauSandboxSession,
  PreparedBureauWorkspace,
} from "./sandbox";

export type RemoteContainerOptions = {
  /** Container runtime to use. Defaults to "docker". */
  runtime?: "docker" | "podman";
  /** Image to run; defaults to the bureau runtime image. */
  image?: string;
};

export function remoteContainer(_options: RemoteContainerOptions = {}): BureauSandboxProvider {
  return {
    name: "remote-container",
    async create(_opts: { preserve: boolean }): Promise<BureauSandboxSession> {
      throw notImplemented("create");
    },
    async prepare(_opts: BureauSandboxPrepareOptions): Promise<PreparedBureauWorkspace> {
      throw notImplemented("prepare");
    },
  };
}

function notImplemented(method: string): Error {
  return new Error(
    `bureau remote-container adapter is not implemented yet (${method}). ` +
      `See the TODO list at the top of bureau/sandbox-remote.ts and #73 ` +
      `for what needs to land. The remote container ships as a typed stub ` +
      `until that work closes.`,
  );
}
