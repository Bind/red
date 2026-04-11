# JSONL Cutover List

This is the current JSONL / rollout-file specific work that should be removed once the new runtime exposes a structured event stream directly.

## Runner container scripts

- [run.sh](/Users/db/workspace/redc/apps/ocr/run.sh)
  - `ROLL_OUT_METADATA_FILE`
  - `CODEX_SESSION_ROOT`
  - `list_rollout_files()`
  - `write_rollout_metadata()`
  - `stream_rollout_activity()`
  - `codex exec --json`
  - `tee "$OUTPUT_DIR/claw-events.jsonl"`
  - copying `claw-events.jsonl` into host output

- [rollout-to-activity.cjs](/Users/db/workspace/redc/apps/ocr/rollout-to-activity.cjs)
  - entire file
  - all event-shape parsing for `thread.started`, `item.completed`, etc.

- [Dockerfile](/Users/db/workspace/redc/apps/ocr/Dockerfile)
  - copy/chmod of `rollout-to-activity.cjs`

## App runner parsing

- [runner.ts](/Users/db/workspace/redc/apps/api/claw/runner.ts)
  - `RolloutMetadata`
  - `ClawEventEnvelope`
  - `readRolloutMetadata()`
  - `readClawEventMetadata()`
  - extracting `codexSessionId` from `claw-events.jsonl`
  - composing logs from raw `stdout`/`stderr`
  - `request.onLog` being fed by CLI output rather than structured runtime events

## Tracker fields that are JSONL-specific

- [types.ts](/Users/db/workspace/redc/apps/api/claw/types.ts)
  - `rolloutPath`

- [tracker.ts](/Users/db/workspace/redc/apps/api/claw/tracker.ts)
  - `rollout_path` column
  - `attachRollout(...)` name and semantics

- [tracker.test.ts](/Users/db/workspace/redc/apps/api/claw/tracker.test.ts)
  - rollout-path fixture assertions

`codexSessionId` may remain, but it should be redefined as the runtime session id, not inferred from rollout filenames.

## Artifact model tied to rollout JSONL

- [artifacts.ts](/Users/db/workspace/redc/apps/api/claw/artifacts.ts)
  - `eventsKey` specifically representing `claw-events.jsonl`
  - `rolloutPath` in `PersistedClawArtifacts`
  - `readTextArtifact(..., "events")` assuming JSONL event files
  - content-type handling for `.jsonl`

- [uploader.ts](/Users/db/workspace/redc/apps/api/claw/uploader.ts)
  - promotion logic driven by `rolloutPath?.startsWith("s3://")`

## API coupling

- [index.ts](/Users/db/workspace/redc/apps/api/index.ts)
  - `/api/claw/runs/:runId/artifacts/:kind` assuming `events` means JSONL
  - switching local vs remote reads based on `rolloutPath`

## UI coupling

- Current UI log behavior is still indirectly coupled to the JSONL translation path because logs originate from parsed Codex CLI output, even though the browser does not read JSONL directly.

Relevant files:

- [api.ts](/Users/db/workspace/redc/apps/web/src/lib/api.ts)
- [change.tsx](/Users/db/workspace/redc/apps/web/src/routes/change.tsx)

## What should survive cutover

- action ids
- prompt files and prompt hashes
- `runId`, `jobId`, `changeId`
- session lifecycle tracking
- artifact read APIs, but with runtime-native artifact/event semantics
