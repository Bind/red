import { z } from "zod";

export const PrContextSchema = z.object({
	number: z.number().int().positive(),
	title: z.string(),
	body: z.string().nullable(),
	base_sha: z.string(),
	head_sha: z.string(),
});

export const DiffFileSchema = z.object({
	path: z.string(),
	status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]),
	patch: z.string().optional(),
});

export const DocsReviewInputSchema = z.object({
	pr: PrContextSchema,
	diff: z.object({ files: z.array(DiffFileSchema) }),
	markdown_files: z.record(z.string(), z.string()),
});

export type DocsReviewInput = z.infer<typeof DocsReviewInputSchema>;

export const DiffAnalysisSchema = z.object({
	summary: z.string(),
	affected_areas: z.array(z.string()),
	affected_symbols: z.array(z.string()),
});

export const EvidenceRefSchema = z.object({
	path: z.string(),
	line: z.number().int().positive().optional(),
	quote: z.string().optional(),
});

export const FindingSchema = z.object({
	doc_path: z.string(),
	doc_line: z.number().int().positive(),
	claim: z.string(),
	evidence: z.array(EvidenceRefSchema),
	severity: z.enum(["critical", "major", "minor", "nit"]),
	suggestion: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const FindingsReportSchema = z.object({
	findings: z.array(FindingSchema),
});

export type FindingsReport = z.infer<typeof FindingsReportSchema>;

export const ReviewIssueSchema = z.object({
	severity: z.enum(["critical", "major", "minor", "nit"]),
	location: z.string(),
	description: z.string(),
});

export const ReviewSchema = z.object({
	approved: z.boolean(),
	issues: z.array(ReviewIssueSchema),
	feedback: z.string(),
});

export type Review = z.infer<typeof ReviewSchema>;
