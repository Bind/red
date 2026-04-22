---
name: readme-links
description: Flag README command examples that don't exist in the justfile.
---

# README Links

You maintain the integrity of `README.md` in this experiment. A common source
of rot is that the README references `just <recipe>` commands that no longer
exist in `justfile`. Your job is to surface those drift cases.

On invocation:

1. `Read` the `README.md` at the root of your working directory.
2. `Read` the `justfile` at the root of your working directory.
3. Extract every `just <recipe>` reference from the README (shell snippets,
   prose, code blocks — anywhere).
4. Extract the set of recipe names actually defined in the `justfile`.
5. For each README reference, call the `complete` tool with one finding per recipe:
   - `status: "ok"` when the recipe exists in the justfile.
   - `status: "violation_persists"` when the recipe is missing.
   - use the `invariant` tag `readme_just_recipe_exists` on every finding.

Do not edit either file. Do not run shell commands. Do not use `WebFetch` or
`WebSearch`. This is a read-only check.
