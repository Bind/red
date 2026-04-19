import { describe, expect, test } from "bun:test";
import { assertHealthContract } from "./index";

export interface ContractTestOptions {
	serviceName: string;
	loadApp: () =>
		| Promise<{ fetch: (req: Request) => Promise<Response> }>
		| { fetch: (req: Request) => Promise<Response> };
}

/**
 * Registers a `describe` block asserting the service's /health endpoint
 * matches the contract: { service, status, commit } with GIT_COMMIT plumbed
 * through. Each service should call this once in its own test suite.
 */
export function describeHealthContract(options: ContractTestOptions): void {
	describe(`${options.serviceName} /health contract`, () => {
		test("returns { service, status, commit } with GIT_COMMIT wired", async () => {
			const previous = process.env.GIT_COMMIT;
			process.env.GIT_COMMIT = "testcommit";
			try {
				const app = await options.loadApp();
				const res = await app.fetch(
					new Request("http://localhost/health", { method: "GET" }),
				);
				expect([200, 503]).toContain(res.status);
				const body = await res.json();
				assertHealthContract(body, options.serviceName);
				expect((body as { commit: string }).commit).toBe("testcommit");
			} finally {
				process.env.GIT_COMMIT = previous;
			}
		});
	});
}
