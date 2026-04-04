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
  await runCommand("docker", ["compose", "-f", composeFile, "up", "-d", "--build", "minio", "minio-init", "git-server"]);

  const publicUrl = composeEnv.GIT_SERVER_PUBLIC_URL;
  try {
    await waitForHttpServer(publicUrl);
    await waitForGitSmartHttp(publicUrl, composeEnv.GIT_SERVER_ADMIN_USERNAME, composeEnv.GIT_SERVER_ADMIN_PASSWORD);
  } catch (error) {
    await runCommand("docker", ["compose", "-f", composeFile, "logs", "--no-color", "git-server"]);
    throw error;
  }

  return {
    publicUrl,
    adminUsername: composeEnv.GIT_SERVER_ADMIN_USERNAME,
    adminPassword: composeEnv.GIT_SERVER_ADMIN_PASSWORD,
    authTokenSecret: composeEnv.GIT_SERVER_AUTH_TOKEN_SECRET,
    async stop() {
      await runCommand("docker", ["compose", "-f", composeFile, "rm", "-sf", "git-server", "minio-init"]);
    },
  };
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

async function waitForGitSmartHttp(baseUrl: string, username: string, password: string) {
  const target = new URL(`${baseUrl}/redc/__healthcheck__.git`);
  target.username = username;
  target.password = password;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await runCommand("git", ["ls-remote", target.toString()]);
      return;
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
