import { describe, expect, test } from "bun:test";
import {
  buildHealth,
  deriveStatus,
  getCommit,
  statusHttpCode,
  verifyHealthContract,
} from "./index";

describe("getCommit", () => {
  test("reads GIT_COMMIT from env", () => {
    expect(getCommit({ GIT_COMMIT: "abc123" })).toBe("abc123");
  });

  test("trims whitespace", () => {
    expect(getCommit({ GIT_COMMIT: "  abc123  " })).toBe("abc123");
  });

  test("falls back to 'unknown' when unset", () => {
    expect(getCommit({})).toBe("unknown");
  });

  test("falls back when empty", () => {
    expect(getCommit({ GIT_COMMIT: "" })).toBe("unknown");
  });
});

describe("deriveStatus", () => {
  test("all ok → ok", () => {
    expect(deriveStatus({ db: { status: "ok" }, api: { status: "ok" } })).toBe("ok");
  });

  test("any degraded → degraded", () => {
    expect(deriveStatus({ db: { status: "ok" }, api: { status: "degraded" } })).toBe("degraded");
  });

  test("any error → error", () => {
    expect(deriveStatus({ db: { status: "degraded" }, api: { status: "error" } })).toBe("error");
  });
});

describe("buildHealth", () => {
  test("minimal call returns service + status + commit", () => {
    const response = buildHealth({
      service: "ctl",
      commit: "abc123",
    });
    expect(response).toEqual({
      service: "ctl",
      status: "ok",
      commit: "abc123",
    });
  });

  test("includes checks and derives status from them", () => {
    const response = buildHealth({
      service: "bff",
      commit: "deadbeef",
      checks: {
        auth: { status: "ok" },
        api: { status: "degraded" },
      },
    });
    expect(response.status).toBe("degraded");
    expect(response.checks).toMatchObject({ auth: { status: "ok" } });
  });

  test("omits startedAt when not provided", () => {
    const response = buildHealth({ service: "x", commit: "c" });
    expect("startedAt" in response).toBe(false);
  });
});

describe("statusHttpCode", () => {
  test("ok → 200", () => expect(statusHttpCode("ok")).toBe(200));
  test("degraded → 503", () => expect(statusHttpCode("degraded")).toBe(503));
  test("error → 503", () => expect(statusHttpCode("error")).toBe(503));
});

describe("verifyHealthContract", () => {
  test("accepts a valid body", () => {
    const result = verifyHealthContract({ service: "x", status: "ok", commit: "c" });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.service).toBe("x");
  });

  test("error has the HealthContractError tag", () => {
    const result = verifyHealthContract({ status: "ok", commit: "c" });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe("HealthContractError");
  });

  test("rejects missing service", () => {
    const result = verifyHealthContract({ status: "ok", commit: "c" });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toMatch(/service/);
  });

  test("rejects invalid status", () => {
    const result = verifyHealthContract({ service: "x", status: "meh", commit: "c" });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toMatch(/status/);
  });

  test("rejects missing commit", () => {
    const result = verifyHealthContract({ service: "x", status: "ok" });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toMatch(/commit/);
  });

  test("rejects wrong service name when expected", () => {
    const result = verifyHealthContract({ service: "ctl", status: "ok", commit: "c" }, "bff");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toMatch(/'bff'/);
  });
});
