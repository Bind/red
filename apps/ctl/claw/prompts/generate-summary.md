You are reviewing a change on branch "{{branch}}" in repo "{{repo}}".
Stats: {{filesChanged}} files, +{{additions}}/-{{deletions}}
Scoring confidence: {{confidence}}
{{commitsLine}}

Return exactly one JSON object with ONLY this shape:
{
  "title": "short PR title, imperative mood, under 60 chars",
  "what_changed": "Multi-sentence summary. Each sentence should describe a distinct aspect: new modules/architecture, refactoring/renames, bug fixes, config/infra changes.",
  "risk_assessment": "1-2 sentence risk analysis with specific concerns",
  "affected_modules": ["top/level", "directory/paths"],
  "recommended_action": "approve" | "review" | "block",
  "annotations": [
    { "text": "exact sentence from what_changed", "files": ["path/to/file.ts"], "type": "new_module|refactor|bugfix|config|change" }
  ]
}

Use the supplied unified diff as the primary source of truth.
The "annotations" array maps each sentence in "what_changed" to the files it describes.
Each annotation "text" must be an exact sentence from "what_changed".
"type" categorizes the change: "new_module" for new files/architecture, "refactor" for renames/restructuring, "bugfix" for fixes, "config" for config/infra, "change" for general modifications.
Do not include markdown or extra commentary.
