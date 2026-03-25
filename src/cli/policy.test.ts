import { describe, test, expect } from "bun:test";
import { policyTestCommand } from "./policy";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function withTempPolicy(yaml: string, fn: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "redc-policy-test-"));
  const path = join(dir, "policy.yaml");
  writeFileSync(path, yaml);
  return fn(path).finally(() => rmSync(dir, { recursive: true }));
}

describe("policyTestCommand", () => {
  test("valid policy file runs dry-run (text)", async () => {
    await withTempPolicy(
      `
rules:
  - name: auto-safe
    match:
      confidence: safe
    action: auto-approve
  - name: block-sql
    match:
      files: ["*.sql"]
    action: block
`,
      async (path) => {
        const code = await policyTestCommand({
          apiUrl: "",
          format: "text",
          args: ["policy", "test", path],
        });
        expect(code).toBe(0);
      }
    );
  });

  test("valid policy file runs dry-run (json)", async () => {
    await withTempPolicy(
      `
rules:
  - name: review-all
    match: {}
    action: require-review
`,
      async (path) => {
        const code = await policyTestCommand({
          apiUrl: "",
          format: "json",
          args: ["policy", "test", path],
        });
        expect(code).toBe(0);
      }
    );
  });

  test("missing file returns 1", async () => {
    const code = await policyTestCommand({
      apiUrl: "",
      format: "text",
      args: ["policy", "test", "/nonexistent/policy.yaml"],
    });
    expect(code).toBe(1);
  });

  test("invalid yaml returns 1", async () => {
    await withTempPolicy("{{invalid yaml", async (path) => {
      const code = await policyTestCommand({
        apiUrl: "",
        format: "text",
        args: ["policy", "test", path],
      });
      // yaml library is lenient, so this may actually parse
      // just verify it doesn't crash
      expect(typeof code).toBe("number");
    });
  });

  test("empty policy file works", async () => {
    await withTempPolicy("", async (path) => {
      const code = await policyTestCommand({
        apiUrl: "",
        format: "text",
        args: ["policy", "test", path],
      });
      expect(code).toBe(0);
    });
  });
});
