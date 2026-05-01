import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDaemons, resolveDaemon } from "../loader";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daemons-loader-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeDaemon(relPath: string, frontmatter: Record<string, unknown>, body = "body") {
  const full = join(dir, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  await writeFile(full, `---\n${yaml}\n---\n\n${body}\n`);
  return full;
}

describe("loadDaemons", () => {
  test("discovers a single valid daemon", async () => {
    await writeDaemon("foo.daemon.md", { name: "foo", description: "does foo" });
    const { specs, errors } = await loadDaemons(dir);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe("foo");
    expect(specs[0]?.scopeRoot).toBe(dir);
    expect(specs[0]?.review.maxTurns).toBe(18);
    expect(specs[0]?.review.routingCategories).toEqual([]);
  });

  test("loads review metadata from frontmatter", async () => {
    await writeDaemon("foo.daemon.md", {
      name: "foo",
      description: "does foo",
      review: {
        max_turns: 7,
        routing_categories: [
          { name: "infra-ops", description: "infra operator files" },
        ],
      },
    });
    const { specs, errors } = await loadDaemons(dir);
    expect(errors).toEqual([]);
    expect(specs[0]?.review.maxTurns).toBe(7);
    expect(specs[0]?.review.routingCategories).toEqual([
      { name: "infra-ops", description: "infra operator files" },
    ]);
  });

  test("scope root is the directory of the file", async () => {
    await writeDaemon("apps/foo/bar.daemon.md", { name: "bar", description: "d" });
    const { specs } = await loadDaemons(dir);
    expect(specs[0]?.scopeRoot).toBe(join(dir, "apps/foo"));
  });

  test("skips node_modules and .git directories", async () => {
    await writeDaemon("ok.daemon.md", { name: "ok", description: "d" });
    await writeDaemon("node_modules/pkg/bad.daemon.md", { name: "bad", description: "d" });
    await writeDaemon(".git/hooks/hidden.daemon.md", { name: "hidden", description: "d" });
    const { specs } = await loadDaemons(dir);
    expect(specs.map((s) => s.name)).toEqual(["ok"]);
  });

  test("records frontmatter errors per-file and keeps going", async () => {
    await writeDaemon("good.daemon.md", { name: "good", description: "d" });
    await writeDaemon("bad.daemon.md", { name: "BadName", description: "d" });
    await writeDaemon("extra.daemon.md", { name: "x", description: "d", on: ["pr.opened"] });
    const { specs, errors } = await loadDaemons(dir);
    expect(specs.map((s) => s.name)).toEqual(["good"]);
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.message.includes("name"))).toBe(true);
    expect(errors.some((e) => e.message.includes("on"))).toBe(true);
  });

  test("flags duplicate names", async () => {
    await writeDaemon("a.daemon.md", { name: "same", description: "d" });
    await writeDaemon("sub/b.daemon.md", { name: "same", description: "d" });
    const { specs, errors } = await loadDaemons(dir);
    expect(specs).toHaveLength(1);
    expect(errors.some((e) => e.message.includes("duplicate daemon name"))).toBe(true);
  });

  test("sorts specs by name", async () => {
    await writeDaemon("z.daemon.md", { name: "zeta", description: "d" });
    await writeDaemon("a.daemon.md", { name: "alpha", description: "d" });
    const { specs } = await loadDaemons(dir);
    expect(specs.map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("resolveDaemon", () => {
  test("returns the spec by name", async () => {
    await writeDaemon("a.daemon.md", { name: "alpha", description: "d" });
    const spec = await resolveDaemon("alpha", dir);
    expect(spec.name).toBe("alpha");
  });

  test("throws when the name is not found", async () => {
    await writeDaemon("a.daemon.md", { name: "alpha", description: "d" });
    await expect(resolveDaemon("beta", dir)).rejects.toThrow(/not found/);
  });
});
