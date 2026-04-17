export type HealthStatus = "ok" | "degraded" | "error";

export interface HealthCheck {
	status: HealthStatus;
	kind?: string;
	details?: string;
}

export interface HealthResponse {
	service: string;
	status: HealthStatus;
	commit: string;
	startedAt?: number;
	checks?: Record<string, HealthCheck>;
}

export interface BuildHealthOptions {
	service: string;
	startedAt?: number;
	checks?: Record<string, HealthCheck>;
	commit?: string;
}

export function getCommit(env: NodeJS.ProcessEnv = process.env): string {
	const value = env.GIT_COMMIT?.trim();
	return value && value.length > 0 ? value : "unknown";
}

export function buildHealth(options: BuildHealthOptions): HealthResponse {
	const commit = options.commit?.trim() || getCommit();
	const status: HealthStatus = options.checks
		? deriveStatus(options.checks)
		: "ok";
	return {
		service: options.service,
		status,
		commit,
		...(options.startedAt !== undefined ? { startedAt: options.startedAt } : {}),
		...(options.checks ? { checks: options.checks } : {}),
	};
}

export function deriveStatus(
	checks: Record<string, HealthCheck>,
): HealthStatus {
	let worst: HealthStatus = "ok";
	for (const check of Object.values(checks)) {
		if (check.status === "error") return "error";
		if (check.status === "degraded") worst = "degraded";
	}
	return worst;
}

export function statusHttpCode(status: HealthStatus): 200 | 503 {
	return status === "ok" ? 200 : 503;
}

export function assertHealthContract(
	body: unknown,
	expectedService?: string,
): asserts body is HealthResponse {
	if (!body || typeof body !== "object") {
		throw new Error(`health body must be an object, got ${typeof body}`);
	}
	const record = body as Record<string, unknown>;
	if (typeof record.service !== "string" || record.service.length === 0) {
		throw new Error("health body must have a non-empty string `service`");
	}
	if (
		record.status !== "ok" &&
		record.status !== "degraded" &&
		record.status !== "error"
	) {
		throw new Error(
			`health body.status must be one of ok|degraded|error, got ${record.status}`,
		);
	}
	if (typeof record.commit !== "string" || record.commit.length === 0) {
		throw new Error("health body must have a non-empty string `commit`");
	}
	if (expectedService && record.service !== expectedService) {
		throw new Error(
			`health body.service must be '${expectedService}', got '${record.service}'`,
		);
	}
}
