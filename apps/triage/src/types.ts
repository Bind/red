import { z } from "zod";

export const WideRollupRecordSchema = z
	.object({
		request_id: z.string(),
		first_ts: z.string(),
		last_ts: z.string(),
		total_duration_ms: z.number(),
		entry_service: z.string(),
		services: z.array(z.string()),
		route_names: z.array(z.string()),
		final_outcome: z.enum(["ok", "error", "unknown"]),
		final_status_code: z.number().nullable(),
		primary_error: z.record(z.unknown()).nullable(),
		events: z.array(z.record(z.unknown())),
	})
	.passthrough();

export type WideRollupRecord = z.infer<typeof WideRollupRecordSchema>;

export const TriageRunRequestSchema = z.object({
	rollup: WideRollupRecordSchema,
});

export const TriagePlanSchema = z.object({
	hypothesis: z.string().min(1),
	suspected_files: z.array(z.string()),
	reproduction_steps: z.array(z.string()),
	proposed_change_summary: z.string().min(1),
	confidence: z.enum(["low", "medium", "high"]),
});

export type TriagePlan = z.infer<typeof TriagePlanSchema>;

export const TriageProposalSchema = z.object({
	repo_id: z.string(),
	branch: z.string(),
	pr_url: z.string().url().optional(),
	summary: z.string(),
});

export type TriageProposal = z.infer<typeof TriageProposalSchema>;

export type TriageRunStatus =
	| "received"
	| "investigating"
	| "plan_ready"
	| "approved"
	| "proposing"
	| "proposal_ready"
	| "rejected"
	| "failed";

export interface TriageRun {
	id: string;
	status: TriageRunStatus;
	created_at: string;
	updated_at: string;
	rollup: WideRollupRecord;
	plan?: TriagePlan;
	proposal?: TriageProposal;
	error?: string;
}
