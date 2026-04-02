#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

interface Options {
  baseUrl: string;
  directory: string;
  prompt: string;
  outFile: string;
  messagesFile?: string;
  responseFile?: string;
  schemaFile?: string;
  model: string;
  system?: string;
  title: string;
  timeoutMs: number;
  username?: string;
  password?: string;
}

const USAGE = `Usage:
  bun src/capture-session.ts --base-url <url> --directory <server-path> --prompt <text> --out-file <path> [--messages-file <path>] [--response-file <path>] [--schema-file <path>] [--model <provider/model>] [--system <text>] [--title <text>] [--timeout-ms <ms>] [--username <name>] [--password <value>]
`;

function parseArgs(argv: string[]): Options {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    i++;
  }

  const baseUrl = options["base-url"];
  const directory = options["directory"];
  const prompt = options["prompt"];
  const outFile = options["out-file"];
  if (!baseUrl || !directory || !prompt || !outFile) {
    throw new Error("Missing required flags");
  }

  return {
    baseUrl,
    directory,
    prompt,
    outFile: resolve(outFile),
    messagesFile: options["messages-file"] ? resolve(options["messages-file"]) : undefined,
    responseFile: options["response-file"] ? resolve(options["response-file"]) : undefined,
    schemaFile: options["schema-file"] ? resolve(options["schema-file"]) : undefined,
    model: options["model"] ?? "openai/gpt-5.4",
    system: options["system"],
    title: options["title"] ?? "redc opencode serve capture",
    timeoutMs: parseTimeout(options["timeout-ms"] ?? "120000"),
    username: options["username"],
    password: options["password"],
  };
}

function parseTimeout(input: string) {
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid timeout "${input}"`);
  }
  return value;
}

function createClient(opts: Options) {
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

function parseModel(input: string) {
  const [providerID, ...rest] = input.split("/");
  const modelID = rest.join("/");
  if (!providerID || !modelID) {
    throw new Error(`Invalid model "${input}". Expected provider/model`);
  }
  return { providerID, modelID };
}

async function main(argv: string[]) {
  const opts = parseArgs(argv);
  await mkdir(dirname(opts.outFile), { recursive: true });
  if (opts.messagesFile) await mkdir(dirname(opts.messagesFile), { recursive: true });
  if (opts.responseFile) await mkdir(dirname(opts.responseFile), { recursive: true });
  const schema = opts.schemaFile ? JSON.parse(await Bun.file(opts.schemaFile).text()) : undefined;

  const client = createClient(opts);
  const model = parseModel(opts.model);
  const session = await client.session.create({ title: opts.title });
  const sessionId = session.data.id;

  const events: any[] = [];
  const abort = new AbortController();
  const subscription = await client.event.subscribe({
    signal: abort.signal,
  } as any);

  const settled = new Promise<any>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      abort.abort();
      rejectPromise(new Error(`Timed out waiting for session ${sessionId} after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    (async () => {
      try {
        for await (const event of subscription.stream as AsyncIterable<any>) {
          const payload = event?.payload ?? event;
          const properties = payload?.properties;
          const eventSessionId = properties?.sessionID ?? properties?.info?.id ?? properties?.info?.sessionID;
          if (eventSessionId !== sessionId) {
            continue;
          }

          events.push(payload);
          await writeFile(opts.outFile, events.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

          if (payload?.type === "session.idle" || payload?.type === "session.error") {
            clearTimeout(timer);
            abort.abort();
            resolvePromise({
              sessionId,
              finalEvent: payload,
            });
            return;
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          clearTimeout(timer);
          rejectPromise(error);
        }
      }
    })().catch(rejectPromise);
  });

  await client.session.promptAsync({
    sessionID: sessionId,
    model,
    parts: [{ type: "text", text: opts.prompt }],
    ...(schema ? { format: { type: "json_schema", schema } } : {}),
    ...(opts.system ? { system: opts.system } : {}),
  });

  const result = await settled;
  const messages = await client.session.messages({
    sessionID: sessionId,
  });
  const assistantText = extractAssistantText(messages.data);

  if (opts.messagesFile) {
    await writeFile(opts.messagesFile, JSON.stringify(messages.data, null, 2), "utf8");
  }

  if (opts.responseFile) {
    await writeFile(opts.responseFile, assistantText, "utf8");
  }

  console.log(JSON.stringify({
    sessionId,
    eventCount: events.length,
    outFile: opts.outFile,
    messagesFile: opts.messagesFile ?? null,
    responseFile: opts.responseFile ?? null,
    finalEvent: result.finalEvent,
  }, null, 2));
}

function extractAssistantText(messages: any[]): string {
  const assistantMessages = messages.filter((message) => message?.info?.role === "assistant");
  const latest = assistantMessages.at(-1);
  if (!latest) return "";
  return (latest.parts ?? [])
    .filter((part: any) => part?.type === "text" && typeof part?.text === "string")
    .map((part: any) => part.text)
    .join("");
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : JSON.stringify(error, null, 2));
    console.error(USAGE);
    process.exit(1);
  }
}
