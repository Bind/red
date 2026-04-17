import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	TriagePlanSchema,
	TriageProposalSchema,
	type TriagePlan,
	type TriageProposal,
	type WideRollupRecord,
} from "../types";
import type { TriageWorkflowRunner } from "./runner";

export interface SmithersRunnerOptions {
	smithersBin: string;
	investigateWorkflowPath: string;
	proposeWorkflowPath: string;
	model: string;
	workingDir?: string;
	timeoutMs?: number;
}

export class SmithersTriageRunner implements TriageWorkflowRunner {
	private readonly opts: Required<Omit<SmithersRunnerOptions, "workingDir">> & {
		workingDir: string;
	};

	constructor(options: SmithersRunnerOptions) {
		this.opts = {
			smithersBin: options.smithersBin,
			investigateWorkflowPath: options.investigateWorkflowPath,
			proposeWorkflowPath: options.proposeWorkflowPath,
			model: options.model,
			workingDir: options.workingDir ?? process.cwd(),
			timeoutMs: options.timeoutMs ?? 10 * 60_000,
		};
	}

	async investigate(rollup: WideRollupRecord): Promise<TriagePlan> {
		const raw = await this.runSmithers(this.opts.investigateWorkflowPath, {
			rollup,
		});
		return TriagePlanSchema.parse(raw);
	}

	async propose(input: {
		rollup: WideRollupRecord;
		plan: TriagePlan;
	}): Promise<TriageProposal> {
		const raw = await this.runSmithers(this.opts.proposeWorkflowPath, input);
		return TriageProposalSchema.parse(raw);
	}

	private async runSmithers(
		workflowPath: string,
		payload: unknown,
	): Promise<unknown> {
		const scratch = await mkdtemp(join(tmpdir(), "redc-triage-"));
		const inputPath = join(scratch, "input.json");
		const outputPath = join(scratch, "output.json");
		await writeFile(inputPath, JSON.stringify(payload), "utf8");

		try {
			await new Promise<void>((resolve, reject) => {
				const child = spawn(
					this.opts.smithersBin,
					[
						"run",
						workflowPath,
						"--input",
						inputPath,
						"--output",
						outputPath,
						"--model",
						this.opts.model,
					],
					{
						cwd: this.opts.workingDir,
						stdio: "inherit",
						env: process.env,
					},
				);
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`smithers workflow timed out after ${this.opts.timeoutMs}ms`));
				}, this.opts.timeoutMs);
				child.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.once("exit", (code) => {
					clearTimeout(timer);
					if (code === 0) {
						resolve();
					} else {
						reject(new Error(`smithers exited with code ${code}`));
					}
				});
			});

			const outputRaw = await readFile(outputPath, "utf8");
			return JSON.parse(outputRaw);
		} finally {
			await rm(scratch, { recursive: true, force: true }).catch(() => {});
		}
	}
}
