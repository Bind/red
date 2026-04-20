#!/usr/bin/env bun
/**
 * Entry point called by .github/workflows/docs-review.yml on every non-draft
 * PR. Gathers PR context + every markdown file, runs the Smithers workflow in
 * a scratch directory, reads the final findings row from the run's SQLite
 * database, and posts a single PR review.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { Octokit } from "@octokit/rest";
import {
	buildPositionIndex,
	mapFindingsToReview,
	type PrFile,
} from "./github";
import {
	FindingsReportSchema,
	type DocsReviewInput,
	type FindingsReport,
} from "./types";

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

async function collectMarkdown(rootDir: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const glob = new Glob("**/*.md");
	for await (const path of glob.scan({ cwd: rootDir, dot: false })) {
		if (path.includes("node_modules/")) continue;
		if (path.startsWith(".git/")) continue;
		files[path] = await readFile(join(rootDir, path), "utf8");
	}
	return files;
}

async function fetchPrContext(
	octokit: Octokit,
	owner: string,
	repo: string,
	pull_number: number,
): Promise<{ title: string; body: string | null; files: PrFile[] }> {
	const [pr, files] = await Promise.all([
		octokit.pulls.get({ owner, repo, pull_number }),
		octokit.paginate(octokit.pulls.listFiles, {
			owner,
			repo,
			pull_number,
			per_page: 100,
		}),
	]);
	return {
		title: pr.data.title,
		body: pr.data.body ?? null,
		files: files.map((f) => ({
			filename: f.filename,
			status: f.status,
			patch: f.patch,
		})),
	};
}

async function runSmithers(options: {
	workflowPath: string;
	inputPath: string;
	dbPath: string;
	runId: string;
	cwd: string;
}): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(
			"bunx",
			[
				"smithers-orchestrator",
				"up",
				options.workflowPath,
				"--run-id",
				options.runId,
				"--input",
				`@${options.inputPath}`,
			],
			{
				cwd: options.cwd,
				stdio: "inherit",
				env: {
					...process.env,
					DOCS_REVIEW_DB_PATH: options.dbPath,
				},
			},
		);
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`smithers exited with code ${code}`));
		});
	});
}

function readFindings(dbPath: string, runId: string): FindingsReport {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.query(
				`SELECT data FROM findings_report
				 WHERE run_id = ? AND node_id = 'find-findings'
				 ORDER BY iteration DESC, created_at DESC
				 LIMIT 1`,
			)
			.get(runId) as { data: string } | null;
		if (!row) {
			throw new Error(
				`no findings_report row for run ${runId}. Did the workflow fail?`,
			);
		}
		return FindingsReportSchema.parse(JSON.parse(row.data));
	} finally {
		db.close();
	}
}

async function main() {
	const [owner, repo] = requiredEnv("REPO").split("/");
	const prNumber = Number.parseInt(requiredEnv("PR_NUMBER"), 10);
	const baseSha = requiredEnv("BASE_SHA");
	const headSha = requiredEnv("HEAD_SHA");
	const githubToken = requiredEnv("GITHUB_TOKEN");

	const octokit = new Octokit({ auth: githubToken });
	const repoRoot = resolve(process.env.REPO_ROOT ?? process.cwd());

	console.log(`fetching PR #${prNumber} context…`);
	const { title, body, files } = await fetchPrContext(
		octokit,
		owner,
		repo,
		prNumber,
	);

	console.log(`collecting markdown under ${repoRoot}…`);
	const markdown = await collectMarkdown(repoRoot);

	const input: DocsReviewInput = {
		pr: {
			number: prNumber,
			title,
			body,
			base_sha: baseSha,
			head_sha: headSha,
		},
		diff: {
			files: files.map((f) => ({
				path: f.filename,
				status: (f.status as DocsReviewInput["diff"]["files"][number]["status"]) ?? "modified",
				patch: f.patch,
			})),
		},
		markdown_files: markdown,
	};

	const scratch = await mkdtemp(join(tmpdir(), "docs-review-"));
	const inputPath = join(scratch, "input.json");
	const dbPath = join(scratch, "smithers.db");
	await writeFile(inputPath, JSON.stringify(input));

	const runId = `docs-review-${randomUUID()}`;
	const workflowPath = resolve(
		dirname(new URL(import.meta.url).pathname),
		"./workflow.tsx",
	);

	console.log(`running smithers workflow (runId=${runId})…`);
	try {
		await runSmithers({
			workflowPath,
			inputPath,
			dbPath,
			runId,
			cwd: repoRoot,
		});

		const report = readFindings(dbPath, runId);
		console.log(`workflow produced ${report.findings.length} finding(s).`);

		const index = buildPositionIndex(files);
		const review = mapFindingsToReview(report.findings, index);

		console.log(
			`posting review: ${review.comments.length} inline comment(s).`,
		);
		await octokit.pulls.createReview({
			owner,
			repo,
			pull_number: prNumber,
			commit_id: headSha,
			body: review.body,
			comments: review.comments,
			event: review.event,
		});
	} finally {
		await rm(scratch, { recursive: true, force: true }).catch(() => {});
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
