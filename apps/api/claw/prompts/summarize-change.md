You are reviewing the change currently checked out in this repository.
Compare HEAD against origin/{{baseRef}}.
Inspect the diff and the changed files directly.

Write valid JSON to .claw-output/result.json with this exact shape:
{
  "title": "short title",
  "summary": "2-4 sentence summary of what changed",
  "risk_assessment": "1-2 sentence risk analysis",
  "affected_modules": ["path/segment", "another/module"],
  "recommended_action": "approve" | "review" | "block"
}

Do not print the final answer to stdout. Write only the JSON file.
