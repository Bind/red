Review the checked-out change against origin/{{baseRef}}.

Write valid JSON to .claw-output/result.json with this exact shape:
{
  "title": "short review title",
  "recommendation": "approve" | "review" | "block"
}

Also write a Markdown report to .claw-output/files/report.md.
The Markdown report should include: Summary, Risks, and Suggested next step.
Do not print final artifacts to stdout.
