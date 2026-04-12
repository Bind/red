You are reviewing the checked-out repository change against origin/{{baseRef}}.
Inspect the existing change carefully.
Then make one small, defensible improvement to the branch.
The improvement should be low-risk and easy to justify from the current code.

After making the improvement, write a unified diff of your changes to .claw-output/files/patch.diff using git diff.
Also write valid JSON to .claw-output/result.json with this exact shape:
{
  "title": "short title",
  "summary": "2-4 sentence summary of the original change",
  "patch_summary": "1-2 sentence summary of the improvement you made",
  "recommended_action": "approve" | "review" | "block"
}

Requirements:
- Do not print the final answer to stdout.
- Ensure .claw-output/files/patch.diff is non-empty.
- Ensure .claw-output/result.json is valid JSON.
