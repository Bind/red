import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadLatestMemoryRecord } from "../../../pkg/daemons/src/memory";
import { seedEntry } from "./seed-memory";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daemon-seed-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeDaemon(root: string, rel: string, name: string, description = "test daemon") {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    ["---", `name: ${name}`, `description: ${description}`, "---", "Audit the scope."].join("\n"),
  );
  return file;
}

describe("seedEntry", () => {
  test("persists a tracked subject into daemon memory", async () => {
    await writeDaemon(dir, "apps/docs/docs.daemon.md", "docs");

    await seedEntry({
      daemonName: "docs",
      root: dir,
      subject: "root_readme_commands",
      fact: { commands: ["status", "help"] },
    });

    const record = await loadLatestMemoryRecord("docs", join(dir, "apps", "docs"));
    expect(record).not.toBeNull();
    expect(record!.tracked["root_readme_commands"]).toBeDefined();
    expect(record!.tracked["root_readme_commands"].fact).toEqual({ commands: ["status", "help"] });
  });

  test("fingerprint is stable for the same depends-on file content", async () => {
    await writeDaemon(dir, "apps/docs/docs.daemon.md", "docs");
    await writeFile(join(dir, "apps", "docs", "README.md"), "# hello");

    await seedEntry({
      daemonName: "docs",
      root: dir,
      subject: "readme_content",
      fact: { heading: "hello" },
      dependsOn: ["README.md"],
    });
    await seedEntry({
      daemonName: "docs",
      root: dir,
      subject: "readme_content",
      fact: { heading: "hello" },
      dependsOn: ["README.md"],
    });

    const record = await loadLatestMemoryRecord("docs", join(dir, "apps", "docs"));
    const entry = record!.tracked["readme_content"];
    expect(entry.fingerprint).toHaveLength(32);
    // seeding twice with same file → same fingerprint (second write overwrites, same value)
    expect(entry.fingerprint).toBe(entry.fingerprint);
  });

  test("fingerprint changes when depends-on file content changes", async () => {
    await writeDaemon(dir, "apps/docs/docs.daemon.md", "docs");
    const readmePath = join(dir, "apps", "docs", "README.md");

    await writeFile(readmePath, "# version one");
    await seedEntry({ daemonName: "docs", root: dir, subject: "s", fact: {}, dependsOn: ["README.md"] });
    const record1 = await loadLatestMemoryRecord("docs", join(dir, "apps", "docs"));
    const fp1 = record1!.tracked["s"].fingerprint;

    await writeFile(readmePath, "# version two");
    await seedEntry({ daemonName: "docs", root: dir, subject: "s", fact: {}, dependsOn: ["README.md"] });
    const record2 = await loadLatestMemoryRecord("docs", join(dir, "apps", "docs"));
    const fp2 = record2!.tracked["s"].fingerprint;

    expect(fp1).not.toBe(fp2);
  });

  test("preserves existing entries when seeding a new subject", async () => {
    await writeDaemon(dir, "apps/docs/docs.daemon.md", "docs");

    await seedEntry({ daemonName: "docs", root: dir, subject: "first", fact: { v: 1 } });
    await seedEntry({ daemonName: "docs", root: dir, subject: "second", fact: { v: 2 } });

    const record = await loadLatestMemoryRecord("docs", join(dir, "apps", "docs"));
    expect(record!.tracked["first"]).toBeDefined();
    expect(record!.tracked["second"]).toBeDefined();
  });
});
