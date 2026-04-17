import type { Finding } from "./types";

export interface PrFile {
	filename: string;
	status: string;
	patch?: string;
}

export interface DiffPositionIndex {
	has(path: string, line: number): boolean;
	position(path: string, line: number): number | undefined;
}

export interface InlineReviewComment {
	path: string;
	position: number;
	body: string;
}

export interface ReviewPayload {
	body: string;
	comments: InlineReviewComment[];
	event: "COMMENT";
}

/**
 * Parse each file's unified-diff patch and build a map from (path, line on
 * the new side) → position-in-diff, which is what the PR review API wants
 * for anchoring inline comments.
 */
export function buildPositionIndex(files: PrFile[]): DiffPositionIndex {
	const map = new Map<string, Map<number, number>>();
	for (const file of files) {
		if (!file.patch) continue;
		const lineIndex = new Map<number, number>();
		let position = 0;
		let newLine = 0;
		let sawFirstHunk = false;
		for (const line of file.patch.split("\n")) {
			if (line.startsWith("@@")) {
				const match = /\+([0-9]+)/.exec(line);
				if (match) newLine = Number.parseInt(match[1], 10) - 1;
				if (sawFirstHunk) position += 1;
				sawFirstHunk = true;
				continue;
			}
			position += 1;
			if (line.startsWith("+") && !line.startsWith("+++")) {
				newLine += 1;
				lineIndex.set(newLine, position);
			} else if (line.startsWith(" ")) {
				newLine += 1;
			}
		}
		map.set(file.filename, lineIndex);
	}
	return {
		has: (path, line) => map.get(path)?.has(line) ?? false,
		position: (path, line) => map.get(path)?.get(line),
	};
}

export function mapFindingsToReview(
	findings: Finding[],
	index: DiffPositionIndex,
): ReviewPayload {
	const comments: InlineReviewComment[] = [];
	const orphaned: Finding[] = [];

	for (const finding of findings) {
		if (index.has(finding.doc_path, finding.doc_line)) {
			const position = index.position(finding.doc_path, finding.doc_line);
			if (position !== undefined) {
				comments.push({
					path: finding.doc_path,
					position,
					body: formatComment(finding, "doc"),
				});
				continue;
			}
		}

		const evidence = finding.evidence.find(
			(ref) => ref.line !== undefined && index.has(ref.path, ref.line),
		);
		if (evidence?.line !== undefined) {
			const position = index.position(evidence.path, evidence.line);
			if (position !== undefined) {
				comments.push({
					path: evidence.path,
					position,
					body: formatComment(finding, "code"),
				});
				continue;
			}
		}

		orphaned.push(finding);
	}

	return {
		body: formatSummary(comments.length, orphaned),
		comments,
		event: "COMMENT",
	};
}

function formatComment(finding: Finding, anchor: "doc" | "code"): string {
	const header =
		anchor === "doc"
			? `**Stale documentation** (${finding.severity})`
			: `**This change makes \`${finding.doc_path}:${finding.doc_line}\` stale** (${finding.severity})`;
	const parts = [header, "", finding.claim];
	if (finding.evidence.length > 0) {
		const list = finding.evidence
			.map((ref) => {
				const where = ref.line ? `${ref.path}:${ref.line}` : ref.path;
				return ref.quote ? `- \`${where}\` — "${ref.quote}"` : `- \`${where}\``;
			})
			.join("\n");
		parts.push("", "Evidence:", list);
	}
	if (finding.suggestion) {
		parts.push("", "Suggested rewrite:", "", "```", finding.suggestion, "```");
	}
	return parts.join("\n");
}

function formatSummary(inlineCount: number, orphaned: Finding[]): string {
	if (inlineCount === 0 && orphaned.length === 0) {
		return "✅ No stale documentation detected.";
	}
	const lines: string[] = ["## Documentation review"];
	if (inlineCount > 0) {
		lines.push(
			"",
			`Posted ${inlineCount} inline comment${inlineCount === 1 ? "" : "s"} on this PR.`,
		);
	}
	if (orphaned.length > 0) {
		lines.push(
			"",
			"### Findings not anchored to this diff",
			"",
			...orphaned.map(
				(f) =>
					`- **\`${f.doc_path}:${f.doc_line}\`** (${f.severity}): ${f.claim}`,
			),
		);
	}
	return lines.join("\n");
}
