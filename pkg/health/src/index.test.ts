import { describe, expect, test } from "bun:test";
import {
	assertHealthContract,
	buildHealth,
	deriveStatus,
	getCommit,
	statusHttpCode,
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
		expect(deriveStatus({ db: { status: "ok" }, api: { status: "ok" } })).toBe(
			"ok",
		);
	});

	test("any degraded → degraded", () => {
		expect(
			deriveStatus({ db: { status: "ok" }, api: { status: "degraded" } }),
		).toBe("degraded");
	});

	test("any error → error", () => {
		expect(
			deriveStatus({ db: { status: "degraded" }, api: { status: "error" } }),
		).toBe("error");
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

describe("assertHealthContract", () => {
	test("accepts a valid body", () => {
		expect(() =>
			assertHealthContract({ service: "x", status: "ok", commit: "c" }),
		).not.toThrow();
	});

	test("rejects missing service", () => {
		expect(() =>
			assertHealthContract({ status: "ok", commit: "c" }),
		).toThrow(/service/);
	});

	test("rejects invalid status", () => {
		expect(() =>
			assertHealthContract({ service: "x", status: "meh", commit: "c" }),
		).toThrow(/status/);
	});

	test("rejects missing commit", () => {
		expect(() =>
			assertHealthContract({ service: "x", status: "ok" }),
		).toThrow(/commit/);
	});

	test("rejects wrong service name when expected", () => {
		expect(() =>
			assertHealthContract(
				{ service: "ctl", status: "ok", commit: "c" },
				"bff",
			),
		).toThrow(/'bff'/);
	});
});
