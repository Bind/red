import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
	TriagePlanSchema,
	TriageProposalSchema,
	type TriagePlan,
	type TriageProposal,
	type WideRollupRecord,
} from "../types";
import type { TriageWorkflowRunner } from "./runner";

export interface SmithersRunnerOptions {
	smithersCommand: string[];
	investigateWorkflowPath: string;
	proposeWorkflowPath: string;
	smithersDbPath: string;
	workingDir?: string;
	timeoutMs?: number;
}

export class SmithersTriageRunner implements TriageWorkflowRunner {
	private readonly opts: Required<Omit<SmithersRunnerOptions, "workingDir">> & {
		workingDir: string;
	};

	constructor(options: SmithersRunnerOptions) {
		if (options.smithersCommand.length === 0) {
			throw new Error("smithersCommand must have at least one element");
		}
		this.opts = {
			smithersCommand: options.smithersCommand,
			investigateWorkflowPath: options.investigateWorkflowPath,
			proposeWorkflowPath: options.proposeWorkflowPath,
			smithersDbPath: options.smithersDbPath,
			workingDir: options.workingDir ?? process.cwd(),
			timeoutMs: options.timeoutMs ?? 30 * 60_000,
		};
	}

	async investigate(rollup: WideRollupRecord): Promise<TriagePlan> {
		const runId = `triage-investigate-${randomUUID()}`;
		await this.runSmithersUp(this.opts.investigateWorkflowPath, runId, {
			rollup,
		});
		const row = this.readLatestRow(runId, "triage_plan", "draft");
		return TriagePlanSchema.parse(row);
	}

	async propose(input: {
		rollup: WideRollupRecord;
		plan: TriagePlan;
	}): Promise<TriageProposal> {
		const runId = `triage-propose-${randomUUID()}`;
		await this.runSmithersUp(this.opts.proposeWorkflowPath, runId, input);
		const row = this.readLatestRow(runId, "triage_proposal", "implement");
		return TriageProposalSchema.parse(row);
	}

	private async runSmithersUp(
		workflowPath: string,
		runId: string,
		payload: unknown,
	): Promise<void> {
		const scratch = await mkdtemp(join(tmpdir(), "redc-triage-"));
		const inputPath = join(scratch, "input.json");
		await Bun.write(inputPath, JSON.stringify(payload));

		const [bin, ...baseArgs] = this.opts.smithersCommand;
		const args = [
			...baseArgs,
			"up",
			workflowPath,
			"--run-id",
			runId,
			"--input",
			`@${inputPath}`,
		];

		try {
			await new Promise<void>((resolve, reject) => {
				const child = spawn(bin, args, {
					cwd: this.opts.workingDir,
					stdio: "inherit",
					env: process.env,
				});
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					reject(
						new Error(
							`smithers workflow timed out after ${this.opts.timeoutMs}ms`,
						),
					);
				}, this.opts.timeoutMs);
				child.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.once("exit", (code) => {
					clearTimeout(timer);
					if (code === 0) resolve();
					else reject(new Error(`smithers exited with code ${code}`));
				});
			});
		} finally {
			await rm(scratch, { recursive: true, force: true }).catch(() => {});
		}
	}

	private readLatestRow(
		runId: string,
		tableName: string,
		nodeId: string,
	): unknown {
		const db = new Database(this.opts.smithersDbPath, { readonly: true });
		try {
			const row = db
				.query(
					`SELECT data FROM ${tableName}
					 WHERE run_id = ? AND node_id = ?
					 ORDER BY iteration DESC, created_at DESC
					 LIMIT 1`,
				)
				.get(runId, nodeId) as { data: string } | null;
			if (!row) {
				throw new Error(
					`no row in ${tableName} for run ${runId} node ${nodeId}`,
				);
			}
			return JSON.parse(row.data);
		} finally {
			db.close();
		}
	}
}
