import type {
  CommandNode,
  PipelineNode,
  ScriptNode,
  SimpleCommandNode,
  StatementNode,
  WordNode,
} from "just-bash";
import type { CommandNodeMetadata } from "../util/types";

type CommandLike = CommandNode & { type: string; line?: number };
type IfClauseLike = {
  condition: StatementNode[];
  body: StatementNode[];
};
type CaseItemLike = {
  patterns: WordNode[];
  body: StatementNode[];
  terminator: ";;" | ";&" | ";;&";
  line?: number;
};
type RedirectionLike = {
  fd: number | null;
  operator: string;
  target: WordNode | { type: "HereDoc"; delimiter: string };
};

export type InstrumentationResult = {
  ast: ScriptNode;
  commandNodes: Record<string, CommandNodeMetadata>;
};

function literal(value: string) {
  return {
    type: "Literal" as const,
    value,
  };
}

function wordFromLiteral(value: string): WordNode {
  return {
    type: "Word",
    parts: [literal(value)],
  };
}

function wordFromStatus(): WordNode {
  return {
    type: "Word",
    parts: [
      {
        type: "ParameterExpansion",
        parameter: "?",
        operation: null,
      },
    ],
  };
}

function wordFromVariable(name: string): WordNode {
  return {
    type: "Word",
    parts: [
      {
        type: "ParameterExpansion",
        parameter: name,
        operation: null,
      },
    ],
  };
}

function beforeHook(nodeId: string): SimpleCommandNode {
  return {
    type: "SimpleCommand",
    assignments: [],
    name: wordFromLiteral("__red_before"),
    args: [wordFromLiteral(nodeId)],
    redirections: [],
  };
}

function afterHook(nodeId: string): SimpleCommandNode {
  return {
    type: "SimpleCommand",
    assignments: [],
    name: wordFromLiteral("__red_after"),
    args: [wordFromLiteral(nodeId), wordFromStatus(), wordFromLiteral("run")],
    redirections: [],
  };
}

function statementFromCommand(command: CommandNode, line?: number): StatementNode {
  return {
    type: "Statement",
    pipelines: [
      {
        type: "Pipeline",
        commands: [command],
        negated: false,
      },
    ],
    operators: [],
    background: false,
    line,
  };
}

function wordPartText(part: {
  type: string;
  value?: string;
  parameter?: string;
  parts?: unknown[];
}): string {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "Escaped":
      return part.value ?? "";
    case "DoubleQuoted":
      return `"${(part.parts ?? []).map((entry) => wordPartText(entry as never)).join("")}"`;
    case "ParameterExpansion":
      return `$${part.parameter ?? ""}`;
    case "CommandSubstitution":
      return "$(...)";
    case "ArithmeticExpansion":
      return "$((...))";
    case "BraceExpansion":
      return "{...}";
    case "Glob":
      return part.value ?? "*";
    case "TildeExpansion":
      return "~";
    case "ProcessSubstitution":
      return "<(...)";
    default:
      return `<${part.type}>`;
  }
}

function wordToText(word: WordNode | null): string {
  if (!word) {
    return "";
  }
  return word.parts.map((part) => wordPartText(part as never)).join("");
}

function simpleCommandText(node: SimpleCommandNode): string {
  const assignments = node.assignments.map((assignment) => {
    if (assignment.array) {
      return `${assignment.name}=(...)`;
    }
    if (!assignment.value) {
      return assignment.name;
    }
    return `${assignment.name}=${wordToText(assignment.value)}`;
  });
  const parts = [
    ...assignments,
    node.name ? wordToText(node.name) : "",
    ...node.args.map((arg) => wordToText(arg)),
    ...node.redirections.map((redirection) => redirectionText(redirection)),
  ].filter(Boolean);
  return parts.join(" ").trim() || "<assignment>";
}

function redirectionText(redirection: RedirectionLike): string {
  const fd = redirection.fd === null ? "" : `${redirection.fd}`;
  const target =
    redirection.target.type === "HereDoc"
      ? redirection.target.delimiter
      : wordToText(redirection.target);
  return `${fd}${redirection.operator}${target}`;
}

function commandName(node: SimpleCommandNode): string {
  return node.name ? wordToText(node.name) || "<word>" : "<assignment>";
}

function wrapSimpleCommand(node: SimpleCommandNode, nodeId: string): CommandNode {
  const conditional: CommandNode = {
    type: "If",
    clauses: [
      {
        condition: [
          statementFromCommand(
            {
              type: "SimpleCommand",
              assignments: [],
              name: wordFromLiteral("test"),
              args: [wordFromVariable("RED_ACTION"), wordFromLiteral("="), wordFromLiteral("run")],
              redirections: [],
            } as CommandNode,
            node.line,
          ),
        ],
        body: [statementFromCommand(node, node.line)],
      },
    ],
    elseBody: null,
    redirections: [],
  } as CommandNode;

  return {
    type: "Group",
    body: [
      statementFromCommand(beforeHook(nodeId), node.line),
      statementFromCommand(conditional, node.line),
      statementFromCommand(
        {
          ...afterHook(nodeId),
          args: [wordFromLiteral(nodeId), wordFromStatus(), wordFromVariable("RED_ACTION")],
        },
        node.line,
      ),
    ],
    redirections: [],
    line: node.line,
  } as CommandNode;
}

function transformPipeline(
  pipeline: PipelineNode,
  path: string,
  commandNodes: Record<string, CommandNodeMetadata>,
): PipelineNode {
  return {
    ...pipeline,
    commands: pipeline.commands.map((command, index) =>
      transformCommand(command as CommandLike, `${path}.cmd${index}`, commandNodes),
    ),
  };
}

function transformStatements(
  statements: StatementNode[],
  path: string,
  commandNodes: Record<string, CommandNodeMetadata>,
): StatementNode[] {
  return statements.map((statement, index) =>
    transformStatement(statement, `${path}.stmt${index}`, commandNodes),
  );
}

function transformCommand(
  command: CommandLike,
  path: string,
  commandNodes: Record<string, CommandNodeMetadata>,
): CommandNode {
  switch (command.type) {
    case "SimpleCommand": {
      const node = command as SimpleCommandNode;
      commandNodes[path] = {
        nodeId: path,
        commandName: commandName(node),
        commandText: simpleCommandText(node),
        line: node.line ?? 0,
      };
      return wrapSimpleCommand(node, path);
    }
    case "FunctionDef":
      return {
        ...command,
        body: transformCommand(command.body as CommandLike, `${path}.body`, commandNodes),
      } as CommandNode;
    case "If":
      return {
        ...command,
        clauses: command.clauses.map((clause: IfClauseLike, index: number) => ({
          condition: transformStatements(
            clause.condition,
            `${path}.if${index}.condition`,
            commandNodes,
          ),
          body: transformStatements(clause.body, `${path}.if${index}.body`, commandNodes),
        })),
        elseBody: command.elseBody
          ? transformStatements(command.elseBody as StatementNode[], `${path}.else`, commandNodes)
          : null,
      } as CommandNode;
    case "For":
    case "CStyleFor":
    case "While":
    case "Until":
    case "Subshell":
    case "Group":
      return {
        ...command,
        body: transformStatements(command.body as StatementNode[], `${path}.body`, commandNodes),
      } as CommandNode;
    case "Case":
      return {
        ...command,
        items: command.items.map((item: CaseItemLike, index: number) => ({
          ...item,
          body: transformStatements(item.body, `${path}.case${index}.body`, commandNodes),
        })),
      } as CommandNode;
    default:
      return command;
  }
}

function transformStatement(
  statement: StatementNode,
  path: string,
  commandNodes: Record<string, CommandNodeMetadata>,
): StatementNode {
  return {
    ...statement,
    pipelines: statement.pipelines.map((pipeline, index) =>
      transformPipeline(pipeline, `${path}.pipe${index}`, commandNodes),
    ),
  };
}

export function instrumentScript(ast: ScriptNode): InstrumentationResult {
  const commandNodes: Record<string, CommandNodeMetadata> = {};
  const transformed: ScriptNode = {
    ...ast,
    statements: transformStatements(ast.statements, "script", commandNodes),
  };

  return {
    ast: transformed,
    commandNodes,
  };
}
