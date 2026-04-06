import { describe, test, expect } from "bun:test";
import { parseArgs, run } from "./index";

describe("parseArgs", () => {
  test("defaults", () => {
    const ctx = parseArgs([]);
    expect(ctx.apiUrl).toBe("http://localhost:3000");
    expect(ctx.format).toBe("text");
    expect(ctx.args).toEqual([]);
  });

  test("parses command", () => {
    const ctx = parseArgs(["status"]);
    expect(ctx.args).toEqual(["status"]);
  });

  test("parses --api-url", () => {
    const ctx = parseArgs(["--api-url", "http://custom:9000", "status"]);
    expect(ctx.apiUrl).toBe("http://custom:9000");
    expect(ctx.args).toEqual(["status"]);
  });

  test("parses --format json", () => {
    const ctx = parseArgs(["--format", "json", "status"]);
    expect(ctx.format).toBe("json");
  });

  test("strips trailing slashes from api url", () => {
    const ctx = parseArgs(["--api-url", "http://localhost:3000///"]);
    expect(ctx.apiUrl).toBe("http://localhost:3000");
  });

});

describe("run", () => {
  test("help returns 0", async () => {
    const code = await run(["help"]);
    expect(code).toBe(0);
  });

  test("no args returns 0 (shows help)", async () => {
    const code = await run([]);
    expect(code).toBe(0);
  });

  test("unknown command returns 1", async () => {
    const code = await run(["nonexistent"]);
    expect(code).toBe(1);
  });
});
