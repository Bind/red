#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

type Command =
  | "list"
  | "health"
  | "inspect"
  | "sessions"
  | "events"
  | "run-task";

interface GlobalOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  directory?: string;
}

interface RunTaskOptions extends GlobalOptions {
  sessionId?: string;
  title?: string;
  prompt?: string;
  promptFile?: string;
  schemaFile?: string;
  agent?: string;
  model?: string;
  system?: string;
  variant?: string;
  timeoutMs?: number;
}

const USAGE = `Usage:
  bun run src/manual.ts list
  bun run src/manual.ts health [--base-url <url>] [--directory <server-path>] [--username <name>] [--password <value>]
  bun run src/manual.ts inspect [--base-url <url>] [--directory <server-path>] [--username <name>] [--password <value>]
  bun run src/manual.ts sessions [--base-url <url>] [--directory <server-path>] [--username <name>] [--password <value>]
  bun run src/manual.ts events [--base-url <url>] [--directory <server-path>] [--username <name>] [--password <value>]
  bun run src/manual.ts run-task [--base-url <url>] [--directory <server-path>] [--session-id <id>] [--title <text>] (--prompt <text> | --prompt-file <path>) [--schema-file <path>] [--agent <name>] [--model <provider/model>] [--system <text>] [--variant <name>] [--timeout-ms <ms>] [--username <name>] [--password <value>]
`;

function parseArgs(argv: string[]) {
  const args = [...argv];
  const command = (args.shift() ?? "list") as Command;

  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    i++;
  }

  const baseUrl = options["base-url"] ?? process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
  const username = options["username"] ?? process.env.OPENCODE_SERVER_USERNAME;
  const password = options["password"] ?? process.env.OPENCODE_SERVER_PASSWORD;
  const directory = options["directory"] ?? process.env.OPENCODE_DIRECTORY;

  return {
    command,
    options,
    global: { baseUrl, username, password, directory } satisfies GlobalOptions,
  };
}

function createClient(opts: GlobalOptions) {
  const authHeader = opts.password
    ? `Basic ${Buffer.from(`${opts.username ?? "opencode"}:${opts.password}`).toString("base64")}`
    : null;

  return createOpencodeClient({
    baseUrl: opts.baseUrl,
    directory: opts.directory,
    throwOnError: true,
    fetch: authHeader
      ? async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          headers.set("Authorization", authHeader);
          return fetch(input, { ...init, headers });
        }
      : fetch,
  });
}

async function resolvePrompt(opts: RunTaskOptions): Promise<string> {
  if (opts.prompt) return opts.prompt;
  if (opts.promptFile) {
    return await readFile(opts.promptFile, "utf8");
  }
  throw new Error("run-task requires --prompt or --prompt-file");
}

async function resolveSchema(schemaFile?: string): Promise<unknown | undefined> {
  if (!schemaFile) return undefined;
  return JSON.parse(await readFile(schemaFile, "utf8"));
}

function parseModel(input?: string) {
  if (!input) return undefined;
  const [providerID, ...rest] = input.split("/");
  const modelID = rest.join("/");
  if (!providerID || !modelID) {
    throw new Error(`Invalid model "${input}". Expected provider/model`);
  }
  return { providerID, modelID };
}

function parseTimeout(input?: string) {
  if (!input) return 120_000;
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid timeout "${input}"`);
  }
  return value;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

async function ensureSession(
  client: ReturnType<typeof createClient>,
  opts: RunTaskOptions
): Promise<{ id: string; title?: string }> {
  if (opts.sessionId) {
    const existing = await client.session.get({ sessionID: opts.sessionId });
    return existing.data as { id: string; title?: string };
  }

  const created = await client.session.create({
    title: opts.title ?? "redc opencode spike",
  });
  return created.data as { id: string; title?: string };
}

function printEvent(event: any, sessionId?: string) {
  const payload = event?.payload ?? event;
  const type = payload?.type;
  const props = payload?.properties;

  if (!type) return;

  if (sessionId) {
    const candidateIds = [
      props?.sessionID,
      props?.info?.id,
      props?.info?.sessionID,
      props?.part?.sessionID,
    ].filter(Boolean);
    if (candidateIds.length > 0 && !candidateIds.includes(sessionId)) {
      return;
    }
  }

  switch (type) {
    case "message.part.delta": {
      if (props?.field === "text" && props?.delta) {
        process.stderr.write(props.delta);
        return;
      }
      break;
    }
    case "message.part.updated": {
      const part = props?.part;
      if (part?.type === "tool" && part?.state?.status) {
        process.stderr.write(`\n[tool:${part.tool}] ${part.state.status}\n`);
        return;
      }
      break;
    }
    case "session.status":
      process.stderr.write(`\n[session.status] ${JSON.stringify(props?.status)}\n`);
      return;
    case "permission.asked":
      process.stderr.write(`\n[permission] ${props?.permission ?? "request"} ${JSON.stringify(props?.patterns ?? [])}\n`);
      return;
    case "permission.replied":
      process.stderr.write(`\n[permission.reply] ${props?.reply ?? "unknown"}\n`);
      return;
    case "session.error":
      process.stderr.write(`\n[session.error] ${JSON.stringify(props?.error ?? null)}\n`);
      return;
    case "session.idle":
      process.stderr.write("\n[session.idle]\n");
      return;
    default:
      break;
  }

  process.stderr.write(`\n[${type}] ${JSON.stringify(props ?? {})}\n`);
}

async function waitForSessionToSettle(
  client: ReturnType<typeof createClient>,
  sessionId: string,
  timeoutMs: number
) {
  const abort = new AbortController();
  const subscription = await client.event.subscribe({
    signal: abort.signal,
  } as any);

  const completion = new Promise<{ reason: "idle" | "error"; event?: any }>((resolve, reject) => {
    const timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`Timed out waiting for session ${sessionId} after ${timeoutMs}ms`));
    }, timeoutMs);

    (async () => {
      try {
        for await (const event of subscription.stream as AsyncIterable<any>) {
          printEvent(event, sessionId);
          const payload = event?.payload ?? event;
          const type = payload?.type;
          const props = payload?.properties;
          if (props?.sessionID !== sessionId) continue;

          if (type === "session.idle") {
            clearTimeout(timer);
            abort.abort();
            resolve({ reason: "idle", event: payload });
            return;
          }

          if (type === "session.error") {
            clearTimeout(timer);
            abort.abort();
            resolve({ reason: "error", event: payload });
            return;
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          clearTimeout(timer);
          reject(error);
        }
      }
    })().catch(reject);
  });

  try {
    return await completion;
  } finally {
    abort.abort();
  }
}

async function runHealth(opts: GlobalOptions) {
  const client = createClient(opts);
  const health = await client.global.health();
  console.log(JSON.stringify(health.data, null, 2));
}

async function runInspect(opts: GlobalOptions) {
  const client = createClient(opts);
  const [health, project, pathInfo, config, vcs] = await Promise.all([
    client.global.health(),
    client.project.current(),
    client.path.get(),
    client.config.get(),
    client.vcs.get(),
  ]);

  console.log(JSON.stringify({
    health: health.data,
    project: project.data,
    path: pathInfo.data,
    config: config.data,
    vcs: vcs.data,
  }, null, 2));
}

async function runSessions(opts: GlobalOptions) {
  const client = createClient(opts);
  const sessions = await client.session.list();
  console.log(JSON.stringify(sessions.data, null, 2));
}

async function runEvents(opts: GlobalOptions) {
  const client = createClient(opts);
  const events = await client.event.subscribe();

  for await (const event of events.stream as AsyncIterable<any>) {
    console.log(JSON.stringify(event, null, 2));
  }
}

async function runTask(opts: RunTaskOptions) {
  const client = createClient(opts);
  const prompt = await resolvePrompt(opts);
  const schema = await resolveSchema(opts.schemaFile);
  const session = await ensureSession(client, opts);
  const model = parseModel(opts.model);
  const timeoutMs = opts.timeoutMs ?? 120_000;

  process.stderr.write(`Using session ${session.id}${session.title ? ` (${session.title})` : ""}\n`);

  await client.session.promptAsync({
    sessionID: session.id,
    parts: [{ type: "text", text: prompt }],
    ...(schema ? { format: { type: "json_schema", schema } } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(model ? { model } : {}),
    ...(opts.system ? { system: opts.system } : {}),
    ...(opts.variant ? { variant: opts.variant } : {}),
  });

  const settled = await waitForSessionToSettle(client, session.id, timeoutMs);
  const messages = await client.session.messages({
    sessionID: session.id,
  });

  console.log(JSON.stringify({
    session,
    settled,
    messages: messages.data,
  }, null, 2));
}

async function main(argv: string[]) {
  const { command, options, global } = parseArgs(argv);

  switch (command) {
    case "list":
      console.log(USAGE.trim());
      return 0;
    case "health":
      await runHealth(global);
      return 0;
    case "inspect":
      await runInspect(global);
      return 0;
    case "sessions":
      await runSessions(global);
      return 0;
    case "events":
      await runEvents(global);
      return 0;
    case "run-task":
      await runTask({
        ...global,
        sessionId: options["session-id"],
        title: options["title"],
        prompt: options["prompt"],
        promptFile: options["prompt-file"],
        schemaFile: options["schema-file"],
        agent: options["agent"],
        model: options["model"],
        system: options["system"],
        variant: options["variant"],
        timeoutMs: parseTimeout(options["timeout-ms"]),
      });
      return 0;
    default:
      throw new Error(`Unknown command: ${String(command)}`);
  }
}

if (import.meta.main) {
  try {
    const code = await main(process.argv.slice(2));
    process.exit(code);
  } catch (error) {
    console.error(formatError(error));
    console.error(USAGE);
    process.exit(1);
  }
}
