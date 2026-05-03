import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { loadDaemons } from "../../../../pkg/daemons/src/index";
import { ROUTING_TRAINING_SET } from "./training-set";

describe("ROUTING_TRAINING_SET", () => {
  test("references real repo files and valid daemon names", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../../");
    const { specs, errors } = await loadDaemons(repoRoot);
    expect(errors).toEqual([]);
    const daemonNames = new Set(specs.map((spec) => spec.name));

    for (const scenario of ROUTING_TRAINING_SET) {
      expect(scenario.files.length).toBeGreaterThan(0);
      for (const file of scenario.files) {
        await access(resolve(repoRoot, file));
        expect(Object.hasOwn(scenario.expectedByFile, file)).toBe(true);
        for (const daemonName of scenario.expectedByFile[file] ?? []) {
          expect(daemonNames.has(daemonName)).toBe(true);
        }
      }
      for (const daemonName of Object.keys(scenario.memoryByDaemon ?? {})) {
        expect(daemonNames.has(daemonName)).toBe(true);
      }
    }
  });
});
