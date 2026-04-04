import { expect, test } from "bun:test";
import { isDockerEnvironmentFailure, parseDfAvailableKilobytes } from "./runner";

test("parseDfAvailableKilobytes reads available space from df -Pk output", () => {
  const output = [
    "Filesystem 1024-blocks Used Available Capacity Mounted on",
    "/dev/disk3s5 482344960 422576128 2097152 100% /System/Volumes/Data",
  ].join("\n");

  expect(parseDfAvailableKilobytes(output)).toBe(2097152 * 1024);
});

test("parseDfAvailableKilobytes returns null for malformed output", () => {
  expect(parseDfAvailableKilobytes("Filesystem\n")).toBeNull();
});

test("isDockerEnvironmentFailure matches overlay and read-only daemon failures", () => {
  expect(
    isDockerEnvironmentFailure(
      "docker: Error response from daemon: mkdir /var/lib/docker/overlay2/abc-init: read-only file system"
    )
  ).toBe(true);
  expect(
    isDockerEnvironmentFailure(
      "docker: Error response from daemon: error creating temporary lease: read-only file system: unknown."
    )
  ).toBe(true);
});

test("isDockerEnvironmentFailure ignores ordinary container exit logs", () => {
  expect(
    isDockerEnvironmentFailure("Cloning repo...\nRunning OpenCode...\nContainer exited with code 1")
  ).toBe(false);
});
