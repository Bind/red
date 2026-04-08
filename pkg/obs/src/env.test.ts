import { describe, expect, test } from "bun:test";
import {
  FileNdjsonSink,
  HttpBatchSink,
  createObsSinkFromEnv,
} from "./collector";
import { ConsoleJsonSink } from "./core";

describe("createObsSinkFromEnv", () => {
  test("defaults to console sink", () => {
    const sink = createObsSinkFromEnv({
      service: "api",
      env: {},
    });
    expect(sink).toBeInstanceOf(ConsoleJsonSink);
  });

  test("builds file sink from env", () => {
    const sink = createObsSinkFromEnv({
      service: "api",
      env: {
        OBS_SINK_MODE: "file",
        OBS_FILE_PATH: "/tmp/obs.ndjson",
      },
    });
    expect(sink).toBeInstanceOf(FileNdjsonSink);
  });

  test("builds collector sink from env", () => {
    const sink = createObsSinkFromEnv({
      service: "api",
      env: {
        OBS_SINK_MODE: "collector",
        WIDE_EVENTS_COLLECTOR_URL: "http://wide-events.internal",
      },
    });
    expect(sink).toBeInstanceOf(HttpBatchSink);
  });

  test("falls back to console sink in test environments", () => {
    const sink = createObsSinkFromEnv({
      service: "api",
      env: {
        NODE_ENV: "test",
        OBS_SINK_MODE: "collector",
        WIDE_EVENTS_COLLECTOR_URL: "http://wide-events.internal",
      },
    });
    expect(sink).toBeInstanceOf(ConsoleJsonSink);
  });
});
