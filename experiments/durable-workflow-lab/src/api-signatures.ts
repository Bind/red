import type { ZodType } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type WorkflowValue = JsonValue | undefined;

export interface WorkflowDefinition<TInput extends WorkflowValue, TOutput extends WorkflowValue> {
  id: string;
  run(ctx: WorkflowContext<TInput>): Promise<TOutput>;
}

export interface WorkflowContext<TInput extends WorkflowValue> {
  input: TInput;
  step: StepRunner;
  sh: ShellTemplate;
  sleep: SleepFn;
  log: LogFn;
}

export interface StepOptions<TOutput extends WorkflowValue = WorkflowValue> {
  output?: ZodType<TOutput>;
  retry?: number;
  timeout?: string | number;
}

export interface ShellOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: string | number;
}

export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  lines(): Promise<string[]>;
}

export interface StepRunner {
  <TOutput extends WorkflowValue>(name: string, run: () => Promise<TOutput>): Promise<TOutput>;

  <TOutput extends WorkflowValue>(
    name: string,
    options: StepOptions<TOutput>,
    run: () => Promise<TOutput>,
  ): Promise<TOutput>;
}

export interface ShellTemplate {
  (pieces: TemplateStringsArray, ...values: unknown[]): Promise<ShellResult>;
  with(options: ShellOptions): ShellTemplate;
}

export type SleepFn = (duration: string | number) => Promise<void>;
export type LogFn = (...parts: unknown[]) => Promise<void> | void;

export function workflow<
  TInput extends WorkflowValue = undefined,
  TOutput extends WorkflowValue = undefined,
>(
  id: string,
  run: (ctx: WorkflowContext<TInput>) => Promise<TOutput>,
): WorkflowDefinition<TInput, TOutput> {
  return { id, run };
}

export function workflowWithDefinition<TInput extends WorkflowValue, TOutput extends WorkflowValue>(
  definition: {
    id: string;
    input?: ZodType<TInput>;
    output?: ZodType<TOutput>;
  },
  run: (ctx: WorkflowContext<TInput>) => Promise<TOutput>,
): WorkflowDefinition<TInput, TOutput> {
  return { id: definition.id, run };
}
