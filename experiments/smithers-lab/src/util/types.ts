import { z } from "zod";

export const runResearchBriefRequestSchema = z.object({
  topic: z.string().min(1),
  audience: z.string().min(1).default("engineering"),
});

export type RunResearchBriefRequest = z.infer<typeof runResearchBriefRequestSchema>;

export type SmithersRunResponse = {
  runId: string;
  status: string;
  output?: unknown;
  error?: unknown;
};

export const wideEvent500AutofixTriggerSchema = z.object({
  requestId: z.string().min(1),
  parentRequestId: z.string().min(1).optional(),
  isRootRequest: z.boolean(),
  service: z.string().min(1),
  route: z.string().min(1),
  method: z.string().min(1),
  statusCode: z.number().int().min(500),
  requestState: z.enum(["completed", "error", "incomplete"]),
  rolledUpAt: z.string().min(1),
  rollupReason: z.enum(["terminal_event", "timeout"]),
  errorMessage: z.string().min(1).optional(),
  fingerprint: z.string().min(1),
  occurrenceCount: z.number().int().min(1),
  windowMinutes: z.number().int().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]).default("high"),
  repo: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  changeId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
});

export type WideEvent500AutofixTrigger = z.infer<typeof wideEvent500AutofixTriggerSchema>;

export const wideEvent500AutofixDiagnosisSchema = z.object({
  failureClass: z.enum([
    "app_regression",
    "config_regression",
    "observability_bug",
    "dependency_outage",
    "infra_transient",
    "unknown",
  ]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  suspectedOwner: z.string().optional(),
  targetRepo: z.string().optional(),
  targetArea: z.string().optional(),
  rootCause: z.string(),
  evidence: z.array(z.string()).min(1),
});

export const wideEvent500AutofixEvidenceSchema = z.object({
  rootRequest: z.boolean(),
  likelyPatchable: z.boolean(),
  signals: z.array(z.string()).min(1),
  servicesTouched: z.array(z.string()).min(1),
  rollupAssessment: z.string(),
  recommendedOwner: z.string().optional(),
  recommendedRepo: z.string().optional(),
});

export const wideEvent500AutofixContextSchema = z.object({
  targetRepo: z.string().optional(),
  targetBranch: z.string().optional(),
  changeId: z.string().optional(),
  runId: z.string().optional(),
  suspectedOwner: z.string().optional(),
  duplicatePrRisk: z.enum(["low", "medium", "high"]),
  notes: z.array(z.string()).min(1),
});

export const wideEvent500AutofixRepairPlanSchema = z.object({
  shouldAttemptFix: z.boolean(),
  reason: z.string(),
  patchType: z.enum(["code", "config", "test_only", "observability", "none"]),
  targetRepo: z.string().optional(),
  targetBranch: z.string().optional(),
  filesLikelyInScope: z.array(z.string()),
  testPlan: z.array(z.string()),
  implementationPrompt: z.string().optional(),
});

export const wideEvent500AutofixWorkflowSummarySchema = z.object({
  decision: z.enum(["diagnose_only", "attempt_fix_later", "ignore"]),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
  recommendedNextStep: z.string(),
  targetRepo: z.string().optional(),
  evidence: z.array(z.string()).min(1),
});

export type WideEvent500AutofixWorkflowSummary = z.infer<
  typeof wideEvent500AutofixWorkflowSummarySchema
>;

export type TriggerGateDecision = {
  accepted: boolean;
  reason: string;
};

export const wideEventTerminalQuerySchema = z.object({
  since: z.string().min(1),
  services: z.array(z.string().min(1)).default([]),
  routes: z.array(z.string().min(1)).default([]),
  requireRootRequest: z.boolean().default(true),
  requestStates: z.array(z.enum(["completed", "incomplete"])).default(["completed"]),
  finalOutcomes: z.array(z.enum(["ok", "error", "unknown"])).default(["error"]),
  minStatusCode: z.number().int().min(500).default(500),
  requireTerminal: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(20),
});

export type WideEventTerminalQuery = z.infer<typeof wideEventTerminalQuerySchema>;

export const wideEventRollupCandidateSchema = z.object({
  requestId: z.string().min(1),
  parentRequestId: z.string().min(1).optional(),
  isRootRequest: z.boolean(),
  service: z.string().min(1),
  route: z.string().min(1),
  method: z.string().min(1).default("GET"),
  statusCode: z.number().int().min(500),
  requestState: z.enum(["completed", "error", "incomplete"]),
  rolledUpAt: z.string().min(1),
  rollupReason: z.enum(["terminal_event", "timeout"]),
  errorMessage: z.string().min(1).optional(),
  fingerprint: z.string().min(1),
  occurrenceCount: z.number().int().min(1),
  windowMinutes: z.number().int().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]).default("high"),
  repo: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  changeId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
});

export type WideEventRollupCandidate = z.infer<typeof wideEventRollupCandidateSchema>;
