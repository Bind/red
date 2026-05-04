# Bureau agent runner

set dotenv-load

# Run a bureau agent; partial name pre-filters fzf, exact name auto-selects
[positional-arguments]
run *args:
    #!/usr/bin/env bash
    set -euo pipefail
    query=""
    if [ $# -gt 0 ] && [[ "${1:-}" != -* ]]; then
        query="$1"
        shift
    fi
    selected_agent="$(
        find bureau/agents -mindepth 1 -maxdepth 1 -type d -exec basename {} \; \
          | sort \
          | fzf --query="$query" --select-1 --exit-0 \
                --prompt='agent> ' --height=40% --reverse
    )"
    [ -n "$selected_agent" ] || exit 0
    bun run bureau/main.ts run "$selected_agent" "$@"

# Resume a bureau session; partial session ID or content pre-filters fzf
[positional-arguments]
resume *args:
    #!/usr/bin/env bash
    set -euo pipefail
    query=""
    if [ $# -gt 0 ] && [[ "${1:-}" != -* ]]; then
        query="$1"
        shift
    fi
    selected_session="$(
        bun -e '
          import { readdir, readFile } from "node:fs/promises";
          import { join } from "node:path";
          const sessionsRoot = join(process.cwd(), ".bureau", "sessions");
          const truncate = (value) => value.length > 120 ? `${value.slice(0, 117)}...` : value;
          try {
            const entries = await readdir(sessionsRoot, { withFileTypes: true });
            const rows = [];
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              const sessionId = String(entry.name);
              const sessionPath = join(sessionsRoot, sessionId, "session.json");
              try {
                const session = JSON.parse(await readFile(sessionPath, "utf8"));
                const messages = Array.isArray(session.messages) ? session.messages : [];
                const lastAssistant = [...messages]
                  .reverse()
                  .find((message) => message && typeof message === "object" && message.role === "assistant");
                const content = typeof lastAssistant?.content === "string"
                  ? lastAssistant.content
                  : Array.isArray(lastAssistant?.content)
                    ? lastAssistant.content
                        .map((part) => typeof part?.text === "string" ? part.text : "")
                        .join(" ")
                    : "";
                rows.push(`${sessionId}\t${truncate(content || "(no assistant output yet)")}`);
              } catch {}
            }
            rows.sort((a, b) => b.localeCompare(a));
            if (rows.length > 0) console.log(rows.join("\n"));
          } catch {}
        ' \
          | fzf --query="$query" --select-1 --exit-0 \
                --delimiter=$'\t' --with-nth=1,2 \
                --prompt='session> ' --height=50% --reverse \
          | cut -f1
    )"
    [ -n "$selected_session" ] || exit 0
    bun run bureau/main.ts resume "$selected_session" "$@"

# Run daemon-executor against a daemon; partial name pre-filters fzf, exact name auto-selects
[positional-arguments]
daemon *args:
    #!/usr/bin/env bash
    set -euo pipefail
    query=""
    if [ $# -gt 0 ] && [[ "${1:-}" != -* ]]; then
        query="$1"
        shift
    fi
    daemon_name="$(
        find . -name "*.daemon.md" \
            -not -path "*/node_modules/*" \
            -not -path "*/.git/*" \
            -not -path "*/.bun-tmp/*" \
          | sort \
          | xargs grep -h -m1 "^name:" \
          | sed 's/^name:[[:space:]]*//' \
          | sort -u \
          | fzf --query="$query" --select-1 --exit-0 \
                --prompt='daemon> ' --height=40% --reverse
    )"
    [ -n "$daemon_name" ] || exit 0
    bun run bureau/main.ts run daemon-executor \
        --args "$(jq -cn --arg name "$daemon_name" '{daemonName: $name, relevantFiles: []}')" \
        "$@"
