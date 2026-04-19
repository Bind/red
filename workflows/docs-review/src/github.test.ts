import { describe, expect, test } from "bun:test";
import {
	buildPositionIndex,
	mapFindingsToReview,
	type PrFile,
} from "./github";
import type { Finding } from "./types";

function patch(lines: string[]): string {
	return lines.join("\n");
}

const docPatch = patch([
	"@@ -1,4 +1,5 @@",
	" # Project",
	"-old intro line",
	"+new intro line",
	"+second added line",
	" unchanged tail",
]);

const codePatch = patch([
	"@@ -10,3 +10,5 @@",
	" function foo() {",
	"-  return 1;",
	"+  return 2;",
	"+  log('ok');",
	" }",
]);

const prFiles: PrFile[] = [
	{ filename: "README.md", status: "modified", patch: docPatch },
	{ filename: "src/foo.ts", status: "modified", patch: codePatch },
];

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		doc_path: "README.md",
		doc_line: 2,
		claim: "intro line is stale",
		evidence: [{ path: "src/foo.ts", line: 11 }],
		severity: "major",
		...overrides,
	};
}

describe("buildPositionIndex", () => {
	test("maps added lines on the new side to their position in the patch", () => {
		const index = buildPositionIndex(prFiles);
		expect(index.has("README.md", 2)).toBe(true);
		expect(index.has("README.md", 3)).toBe(true);
		expect(index.position("README.md", 2)).toBe(3);
		expect(index.position("README.md", 3)).toBe(4);
	});

	test("does not include removed-only lines on the new side", () => {
		const index = buildPositionIndex(prFiles);
		expect(index.has("README.md", 99)).toBe(false);
	});

	test("counts context lines against the new-side line number", () => {
		const index = buildPositionIndex(prFiles);
		expect(index.has("README.md", 1)).toBe(false);
		expect(index.has("src/foo.ts", 11)).toBe(true);
	});

	test("ignores files without a patch", () => {
		const index = buildPositionIndex([
			{ filename: "binary.png", status: "added" },
		]);
		expect(index.has("binary.png", 1)).toBe(false);
	});
});

describe("mapFindingsToReview", () => {
	const index = buildPositionIndex(prFiles);

	test("anchors to the doc line when the doc is in the diff", () => {
		const review = mapFindingsToReview([finding()], index);
		expect(review.comments).toHaveLength(1);
		expect(review.comments[0].path).toBe("README.md");
		expect(review.comments[0].position).toBe(3);
		expect(review.comments[0].body).toContain("Stale documentation");
	});

	test("falls back to evidence line when the doc line is not in the diff", () => {
		const review = mapFindingsToReview(
			[finding({ doc_line: 999 })],
			index,
		);
		expect(review.comments).toHaveLength(1);
		expect(review.comments[0].path).toBe("src/foo.ts");
		expect(review.comments[0].body).toContain("makes `README.md:999` stale");
	});

	test("orphans findings whose anchors are absent from the diff", () => {
		const review = mapFindingsToReview(
			[
				finding({
					doc_line: 999,
					evidence: [{ path: "src/other.ts", line: 5 }],
				}),
			],
			index,
		);
		expect(review.comments).toHaveLength(0);
		expect(review.body).toContain("not anchored to this diff");
		expect(review.body).toContain("README.md:999");
	});

	test("returns an empty-state summary when there are no findings", () => {
		const review = mapFindingsToReview([], index);
		expect(review.comments).toHaveLength(0);
		expect(review.body).toContain("No stale documentation");
		expect(review.event).toBe("COMMENT");
	});

	test("mixes inline and summary findings in one review", () => {
		const review = mapFindingsToReview(
			[
				finding(),
				finding({
					doc_path: "CLAUDE.md",
					doc_line: 5,
					evidence: [{ path: "untracked.ts", line: 1 }],
				}),
			],
			index,
		);
		expect(review.comments).toHaveLength(1);
		expect(review.body).toContain("CLAUDE.md:5");
	});
});
