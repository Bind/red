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
		if (index.has(finding.file_path, finding.file_line)) {
			const position = index.position(finding.file_path, finding.file_line);
			if (position !== undefined) {
				comments.push({
					path: finding.file_path,
					position,
					body: formatComment(finding),
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

function formatComment(finding: Finding): string {
	const parts = [
		`**Repo pattern review** (${finding.severity})`,
		"",
		`Rule: ${finding.rule}`,
		"",
		finding.issue,
		"",
		`Why this matters: ${finding.rationale}`,
	];
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
		parts.push("", "Suggested change:", "", "```", finding.suggestion, "```");
	}
	return parts.join("\n");
}

function formatSummary(inlineCount: number, orphaned: Finding[]): string {
	if (inlineCount === 0 && orphaned.length === 0) {
		return "✅ No repo-pattern issues detected.";
	}
	const lines: string[] = ["## Repo pattern review"];
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
					`- **\`${f.file_path}:${f.file_line}\`** (${f.severity}) ${f.rule}: ${f.issue}`,
			),
		);
	}
	return lines.join("\n");
}
