#!/usr/bin/env node

const readline = require("node:readline");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const activity = parseActivity(line);
  if (activity) {
    process.stdout.write(`${activity}\n`);
  }
});

function parseActivity(line) {
  if (!line.trim()) return null;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  switch (event.type) {
    case "thread.started":
      return event.thread_id ? `Claw thread ${event.thread_id} started` : "Claw thread started";
    case "turn.started":
      return "Turn started";
    case "turn.completed":
      return "Turn completed";
    case "session_meta":
      return event.payload?.id ? `Claw session ${event.payload.id} started` : "Claw session started";
    case "event_msg":
      return formatEventMessage(event.payload);
    case "response_item":
      return formatResponseItem(event.payload);
    case "item.started":
    case "item.completed":
      return formatItemEvent(event.item, event.type === "item.started");
    default:
      return null;
  }
}

function formatEventMessage(payload) {
  if (!payload || typeof payload !== "object") return null;

  switch (payload.type) {
    case "task_started":
      return "Task started";
    case "task_complete":
      return "Task completed";
    case "agent_message":
      return cleanText(payload.message);
    default:
      return null;
  }
}

function formatResponseItem(payload) {
  if (!payload || typeof payload !== "object") return null;

  if (payload.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
    const text = payload.content
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        if (typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return text ? cleanText(text) : null;
  }

  return null;
}

function formatItemEvent(item, isStarted) {
  if (!item || typeof item !== "object") return null;

  switch (item.type) {
    case "agent_message": {
      const text = cleanText(item.text);
      return text || null;
    }
    case "command_execution": {
      const command = cleanText(item.command);
      if (!command) return null;
      if (isStarted) {
        return `Running command: ${command}`;
      }
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
      const summary = summarizeCommandOutput(item.aggregated_output);
      if (exitCode === 0) {
        return summary
          ? `Command completed: ${command} -> ${summary}`
          : `Command completed: ${command}`;
      }
      return exitCode != null
        ? `Command failed (${exitCode}): ${command}`
        : `Command finished: ${command}`;
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((change) => (change && typeof change.path === "string" ? change.path : ""))
        .filter(Boolean);
      if (paths.length === 0) return null;
      const prefix = isStarted ? "Updating files" : "Updated files";
      return `${prefix}: ${paths.join(", ")}`;
    }
    default:
      return null;
  }
}

function cleanText(text) {
  if (typeof text !== "string") return null;
  const normalized = text
    .replace(/\s+/g, " ")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();
  return normalized || null;
}

function summarizeCommandOutput(output) {
  if (typeof output !== "string") return null;
  const normalized = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
  return normalized || null;
}
