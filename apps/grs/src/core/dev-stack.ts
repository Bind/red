import { join } from "node:path";

export interface StartedDevGitServer {
  publicUrl: string;
  adminUsername: string;
  adminPassword: string;
  authTokenSecret: string;
  stop(): Promise<void>;
}

interface CommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export async function startDevGitServer(): Promise<StartedDevGitServer> {
  const composeFile = join(import.meta.dir, "..", "..", "..", "..", "infra", "compose", "dev.yml");
  const composeEnv = await readComposeEnv(composeFile, [
    "GIT_SERVER_PUBLIC_URL",
    "GIT_SERVER_ADMIN_USERNAME",
    "GIT_SERVER_ADMIN_PASSWORD",
    "GIT_SERVER_AUTH_TOKEN_SECRET",
  ]);
  await removeComposeServicesBestEffort(composeFile, ["grs", "init"]);
  await composeUpWithRetry(composeFile, ["s3", "init", "grs"], process.env.GIT_SERVER_BUILD_ON_START === "1");

  const publicUrl = composeEnv.GIT_SERVER_PUBLIC_URL;
  try {
    await waitForHttpServer(publicUrl);
    await waitForGitSmartHttpRoute(publicUrl, composeEnv.GIT_SERVER_ADMIN_USERNAME, composeEnv.GIT_SERVER_ADMIN_PASSWORD);
  } catch (error) {
    await runCommand("docker", ["compose", "-f", composeFile, "logs", "--no-color", "grs"]);
    throw error;
  }

  return {
    publicUrl,
    adminUsername: composeEnv.GIT_SERVER_ADMIN_USERNAME,
    adminPassword: composeEnv.GIT_SERVER_ADMIN_PASSWORD,
    authTokenSecret: composeEnv.GIT_SERVER_AUTH_TOKEN_SECRET,
    async stop() {
      await removeComposeServicesBestEffort(composeFile, ["grs", "init"]);
    },
  };
}

async function composeUpWithRetry(composeFile: string, services: string[], build: boolean) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const args = ["compose", "-f", composeFile, "up", "-d"];
      if (build) args.push("--build");
      args.push(...services);
      await runCommand("docker", args);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientComposeConflict(error)) {
        throw error;
      }
      await Bun.sleep(500 * (attempt + 1));
      await removeComposeServicesBestEffort(composeFile, ["grs", "init"]);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("timed out starting git server compose stack");
}

async function removeComposeServicesBestEffort(composeFile: string, services: string[]) {
  try {
    await runCommand("docker", ["compose", "-f", composeFile, "rm", "-sf", ...services]);
  } catch (error) {
    if (!isTransientComposeConflict(error)) {
      throw error;
    }
  }
}

function isTransientComposeConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("removal of container") ||
    message.includes("already in progress") ||
    message.includes("already in use by container") ||
    message.includes("No such container")
  );
}

async function waitForHttpServer(baseUrl: string) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(baseUrl);
      if (response.status < 500) {
        return;
      }
      throw new Error(`server returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw lastError instanceof Error ? lastError : new Error("timed out waiting for git server");
}

async function waitForGitSmartHttpRoute(baseUrl: string, username: string, password: string) {
  const target = new URL("/red/__healthcheck__.git/info/refs?service=git-upload-pack", baseUrl);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(target, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        },
      });
      if (response.status < 500) {
        return;
      }
      throw new Error(`smart-http probe returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw lastError instanceof Error ? lastError : new Error("timed out waiting for git smart http");
}

async function readComposeEnv(composeFile: string, names: string[]) {
  const { stdout } = await runCommand("docker", ["compose", "-f", composeFile, "config"]);
  const values = Object.fromEntries(names.map((name) => [name, extractComposeEnv(stdout, name)])) as Record<string, string>;
  for (const [name, value] of Object.entries(values)) {
    if (!value) {
      throw new Error(`Missing required compose env: ${name}`);
    }
  }
  return values;
}

function extractComposeEnv(config: string, name: string) {
  const pattern = new RegExp(`^\\s+${name}:\\s*(.+)$`, "m");
  const match = config.match(pattern);
  return match ? match[1].replace(/^['"]|['"]$/g, "") : "";
}

export async function runCommand(command: string, args: string[], options: CommandOptions = {}) {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}

export async function runCommandWithRetry(
  command: string,
  args: string[],
  options: CommandOptions = {},
  retries = 10,
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await runCommand(command, args, options);
    } catch (error) {
      lastError = error;
      if (!isTransientCommandError(error)) {
        throw error;
      }
      await Bun.sleep(250 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${command} ${args.join(" ")} failed after retries`);
}

function isTransientCommandError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Couldn't connect to server") ||
    message.includes("Failed to connect to 127.0.0.1 port 9080") ||
    message.includes("Empty reply from server")
  );
}
