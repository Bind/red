import type { WideEventSink } from "../pkg/daemons/src/index";

export type BureauAgentAssets = {
  skills: Array<{ path: string; content: string }>;
};

export type BureauAgentContext<Input> = {
  name: string;
  sessionId: string;
  sourceRoot: string;
  root: string;
  cwd: string;
  input: Input;
  agentDir: string;
  assets: BureauAgentAssets;
  emit: WideEventSink;
  resolveAsset(relativePath: string): string;
  resolveSharedAsset(relativePath: string): string;
};

export type BureauExecutionPlan = {
  systemPrompt: string;
  initialInput: string;
  tools?: any[];
  cwd?: string;
};

export type BureauAgentDefinition<Input = unknown> = {
  run(ctx: BureauAgentContext<Input>): Promise<BureauExecutionPlan>;
};

type BureauInstructionBuilder<Input, Shared> =
  | string
  | ((ctx: BureauAgentContext<Input>, shared: Shared) => string | Promise<string>);

type BureauInputBuilder<Input, Shared> =
  | string
  | ((ctx: BureauAgentContext<Input>, shared: Shared) => string | Promise<string>);

type BureauToolBuilder<Input, Shared> = (
  ctx: BureauAgentContext<Input>,
  shared: Shared,
) => any[] | Promise<any[]>;

export function agent<Input = unknown, Shared = undefined>(shared?: Shared) {
  let instructions: BureauInstructionBuilder<Input, Shared> | undefined;
  let initialInput: BureauInputBuilder<Input, Shared> | undefined;
  let createTools: BureauToolBuilder<Input, Shared> | undefined;
  let customPlan:
    | ((
        ctx: BureauAgentContext<Input>,
        shared: Shared,
      ) => Promise<BureauExecutionPlan> | BureauExecutionPlan)
    | undefined;

  const builder = {
    instructions(value: BureauInstructionBuilder<Input, Shared>) {
      instructions = value;
      return builder;
    },
    initialInput(value: BureauInputBuilder<Input, Shared>) {
      initialInput = value;
      return builder;
    },
    tools(value: BureauToolBuilder<Input, Shared>) {
      createTools = value;
      return builder;
    },
    plan(
      value: (
        ctx: BureauAgentContext<Input>,
        shared: Shared,
      ) => Promise<BureauExecutionPlan> | BureauExecutionPlan,
    ) {
      customPlan = value;
      return builder;
    },
    build(): BureauAgentDefinition<Input> {
      return {
        async run(ctx) {
          if (customPlan) {
            return await customPlan(ctx, shared as Shared);
          }

          return {
            systemPrompt: await resolveInstructionValue(ctx, shared as Shared, instructions),
            initialInput: await resolveInputValue(ctx, shared as Shared, initialInput),
            tools: createTools ? await createTools(ctx, shared as Shared) : [],
            cwd: ctx.cwd,
          };
        },
      };
    },
  };

  return builder;
}

export const createAgent = agent;

async function resolveInstructionValue<Input, Shared>(
  ctx: BureauAgentContext<Input>,
  shared: Shared,
  value: BureauInstructionBuilder<Input, Shared> | undefined,
): Promise<string> {
  if (!value) return "";
  return typeof value === "function" ? await value(ctx, shared) : value;
}

async function resolveInputValue<Input, Shared>(
  ctx: BureauAgentContext<Input>,
  shared: Shared,
  value: BureauInputBuilder<Input, Shared> | undefined,
): Promise<string> {
  if (!value) return "";
  return typeof value === "function" ? await value(ctx, shared) : value;
}
