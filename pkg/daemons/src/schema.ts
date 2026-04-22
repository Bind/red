import { z } from "zod";

const name = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, "name must be kebab-case, 1-64 chars, start with a letter");

const description = z.string().min(1).max(200);

export const DaemonFrontmatter = z
  .object({
    name,
    description,
  })
  .strict();

export type DaemonFrontmatter = z.infer<typeof DaemonFrontmatter>;

export const CompleteFinding = z
  .object({
    invariant: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "invariant is a snake_case tag"),
    target: z.string().optional(),
    status: z.enum(["ok", "healed", "violation_persists", "skipped"]),
    note: z.string().optional(),
  })
  .strict();

export const CompletePayload = z
  .object({
    summary: z.string().min(1),
    findings: z.array(CompleteFinding).default([]),
    nextRunHint: z.string().optional(),
  })
  .strict();

export type CompletePayload = z.infer<typeof CompletePayload>;
export type CompleteFinding = z.infer<typeof CompleteFinding>;
