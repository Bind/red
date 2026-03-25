import { ForgejoClient } from "../forgejo/client";
import type { CliContext } from "./index";

// ── Git helpers ──────────────────────────────────────────

export function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(`git ${args[0]} failed: ${stderr}`);
  }
  return result.stdout.toString().trim();
}

export interface GitHubRemote {
  username: string;
  repoName: string;
}

/** Extract GitHub username and repo from SSH or HTTPS remote URLs. */
export function parseGitHubRemote(url: string): GitHubRemote | null {
  // SSH: git@github.com:user/repo.git
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { username: sshMatch[1], repoName: sshMatch[2] };
  }

  // HTTPS: https://github.com/user/repo.git or https://github.com/user/repo
  const httpsMatch = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    return { username: httpsMatch[1], repoName: httpsMatch[2] };
  }

  return null;
}

function getRemoteUrl(): string | null {
  try {
    return git("remote", "get-url", "origin");
  } catch {
    return null;
  }
}

// ── Interactive prompt ────────────────────────────────────

async function prompt(message: string): Promise<string> {
  process.stdout.write(`${message} `);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

// ── GitHub key fetch ─────────────────────────────────────

export async function fetchGitHubKeys(username: string): Promise<string[]> {
  const res = await fetch(`https://github.com/${encodeURIComponent(username)}.keys`);
  if (!res.ok) {
    throw new Error(`Failed to fetch SSH keys for ${username}: ${res.status}`);
  }
  const text = await res.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ── Bootstrap command ────────────────────────────────────

interface BootstrapEnv {
  forgejoUrl: string;
  forgejoToken: string;
  webhookSecret: string;
  redcPort: string;
}

function loadBootstrapEnv(): BootstrapEnv | null {
  const forgejoUrl = process.env.FORGEJO_URL;
  const forgejoToken = process.env.FORGEJO_TOKEN;
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const redcPort = process.env.REDC_PORT ?? "3000";

  if (!forgejoUrl || !forgejoToken || !webhookSecret) {
    return null;
  }

  return { forgejoUrl, forgejoToken, webhookSecret, redcPort };
}

export async function bootstrapCommand(ctx: CliContext): Promise<number> {
  // Load env
  const env = loadBootstrapEnv();
  if (!env) {
    console.error(
      "Missing required env vars: FORGEJO_URL, FORGEJO_TOKEN, WEBHOOK_SECRET"
    );
    console.error("Run 'just setup' first to configure the environment.");
    return 1;
  }

  const forgejo = new ForgejoClient({
    baseUrl: env.forgejoUrl,
    token: env.forgejoToken,
  });

  // Step 1: Resolve username and repo name
  console.log("→ Resolving identity...");
  let username: string | null = null;
  let repoName: string | null = null;

  // Try git remote origin first
  const remoteUrl = getRemoteUrl();
  if (remoteUrl) {
    const remote = parseGitHubRemote(remoteUrl);
    if (remote) {
      username = remote.username;
      repoName = remote.repoName;
    }
  }

  // Prompt for GitHub username if not inferred from remote
  if (!username) {
    username = await prompt("GitHub username:");
    if (!username) {
      console.error("Username is required.");
      return 1;
    }
  }

  // Sanitize username
  username = username.replace(/\s+/g, "-");

  // Fall back to current directory name for repo
  if (!repoName) {
    const cwd = process.cwd();
    const dirName = cwd.split("/").pop() ?? "repo";
    repoName = await prompt(`Repo name [${dirName}]:`) || dirName;
  }

  console.log(`  User: ${username}`);
  console.log(`  Repo: ${repoName}`);

  // Step 2: Fetch SSH keys from GitHub
  console.log("→ Porting public keys from GitHub...");
  let keys: string[];
  try {
    keys = await fetchGitHubKeys(username);
  } catch {
    keys = [];
  }

  if (keys.length === 0) {
    console.error(
      `No SSH keys found for GitHub user '${username}'.`
    );
    console.error(
      "Add an SSH key at https://github.com/settings/keys and try again."
    );
    return 1;
  }
  console.log(`  Found ${keys.length} SSH key(s)`);

  // Step 3: Create Forgejo user
  console.log("→ Creating Forgejo user...");
  const password = `redc-${username}-${Date.now()}`;
  const user = await forgejo.createUser({
    username,
    password,
    email: `${username}@redc.local`,
    must_change_password: false,
  });
  if (user) {
    console.log(`  Created user: ${username}`);
  } else {
    console.log(`  User '${username}' already exists`);
  }

  // Step 4: Upload SSH keys
  console.log("→ Uploading SSH keys...");
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const title = `github-key-${i}`;
    const result = await forgejo.uploadSSHKey(username, title, key);
    if (result) {
      console.log(`  Uploaded key: ${title}`);
    } else {
      console.log(`  Key '${title}' already exists`);
    }
  }

  // Step 5: Create repo
  console.log("→ Creating Forgejo repo...");
  const repo = await forgejo.createUserRepo(username, {
    name: repoName,
    auto_init: true,
    default_branch: "main",
  });
  if (repo) {
    console.log(`  Created repo: ${username}/${repoName}`);
  } else {
    console.log(`  Repo '${username}/${repoName}' already exists`);
  }

  // Step 6: Create webhook
  console.log("→ Creating webhook...");
  const webhookUrl = `http://host.docker.internal:${env.redcPort}/webhook/push`;
  const webhook = await forgejo.createWebhook(username, repoName, {
    url: webhookUrl,
    secret: env.webhookSecret,
    events: ["push"],
  });
  if (webhook) {
    console.log(`  Created webhook → ${webhookUrl}`);
  } else {
    console.log(`  Webhook already exists`);
  }

  // Step 7: Add/update git remote (only if inside a git repo)
  const redcRemoteUrl = `ssh://git@localhost:2222/${username}/${repoName}.git`;
  let isGitRepo = false;
  try {
    git("rev-parse", "--git-dir");
    isGitRepo = true;
  } catch {}

  if (isGitRepo) {
    console.log("→ Configuring git remote 'redc'...");
    try {
      git("remote", "get-url", "redc");
      git("remote", "set-url", "redc", redcRemoteUrl);
      console.log(`  Updated remote: ${redcRemoteUrl}`);
    } catch {
      git("remote", "add", "redc", redcRemoteUrl);
      console.log(`  Added remote: ${redcRemoteUrl}`);
    }
  } else {
    console.log(`→ Not a git repo — add the remote manually:`);
    console.log(`  git remote add redc ${redcRemoteUrl}`);
  }

  // Step 8: Done
  console.log("");
  console.log("=== Bootstrap complete ===");
  console.log("Next step:");
  console.log("  git push redc main");

  return 0;
}
