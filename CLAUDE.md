# pr-watcher

A Claude Code [channel](https://code.claude.com/docs/en/channels) (custom MCP server) that polls the currently checked-out PR and pushes change events into the running Claude Code session.

## Architecture

Single Bun TypeScript file: `pr-watcher.ts`. Claude Code spawns it as an MCP subprocess over stdio. Inside the process:

1. **Poller** — a `setTimeout`-driven loop calls `gh` and parses JSON.
2. **Differ** — compares results against an in-memory `Snapshot` and produces events.
3. **Emitter** — sends each event as `notifications/claude/channel` via `mcp.notification()`. Events arrive in Claude's context as `<channel source="pr-watcher" kind="..." ...>` tags.

State is **in-memory only**. On startup or after switching to a different PR, the watcher captures current state and emits only `startup` / `pr_changed` — it does not backfill historical reviews/comments/checks.

## Key design choices (do not regress)

- **One-way channel.** No `tools`, no reply tool, no permission relay. The agent reacts using whatever it already has (`gh`, file edits). If you're tempted to add a reply tool or a "respond to review" tool, push back: the user can already do that via `gh pr comment` etc.
- **Factual `instructions` only.** The MCP server's `instructions` string describes event format and lists `kind` values. It does **not** tell Claude how to handle events. Project-specific handling lives in skills / CLAUDE.md inside the *consuming* project, not here.
- **Auto-detect PR from current branch.** Re-detected on every tick so a `git checkout` is picked up naturally. No CLI flags, no config file.
- **Lean on `gh`.** No octokit dep, no GITHUB_TOKEN handling. `gh` already has auth.
- **Single PR at a time.** No multi-PR support.
- **No persistence.** Don't add a state file unless there's a real reason — bootstrap-on-start is fine and simpler.

## Polling cadence (in `pr-watcher.ts`)

- `FAST_MS = 15_000` — any check has `bucket === 'pending'`
- `NORMAL_MS = 60_000` — PR exists, all checks settled
- `IDLE_MS = 300_000` — no PR for current branch (or detached HEAD)

## Events emitted

`startup`, `no_pr`, `pr_changed`, `commits_pushed`, `ci_status`, `review`, `review_comment`, `issue_comment`, `pr_state`. See `README.md` for meta attributes.

Bodies are short and factual. Don't add "you should…" language.

## Data sources (`gh` commands)

| call                                                            | for                       |
| --------------------------------------------------------------- | ------------------------- |
| `gh pr view --json number,url,headRefOid,headRefName,state,...` | PR meta + head SHA        |
| `gh pr checks --json name,state,bucket,link`                    | CI checks                 |
| `gh api repos/{owner}/{repo}/pulls/{n}/reviews`                 | reviews                   |
| `gh api repos/{owner}/{repo}/pulls/{n}/comments`                | inline review comments    |
| `gh api repos/{owner}/{repo}/issues/{n}/comments`               | top-level PR comments     |

`gh pr checks` exposes `state` (e.g. `IN_PROGRESS`, `SUCCESS`) and `bucket` (`pass`/`fail`/`pending`/`skipping`/`cancel`). Cadence and "is the check still running" decisions key off `bucket === 'pending'`.

## Run / test

```bash
bun install                                                          # deps
claude --dangerously-load-development-channels server:pr-watcher     # run a session
```

The `--dangerously-load-...` flag is required during the channels research preview because this server isn't on the official Anthropic allowlist. `server:pr-watcher` matches the key in `.mcp.json`.

Smoke test (no Claude Code needed) — should print one notification, then hang:
```bash
( bun ./pr-watcher.ts < /dev/null & PID=$!; sleep 2; kill $PID ) 2>&1
```

The MCP server logs to stderr with prefix `[pr-watcher]`. Stdout is reserved for the JSON-RPC protocol — never `console.log` to stdout.

## When changing this code

- Don't run `bun dev` or any long-running dev server. Ask the user to test instead.
- If you add new event `kind` values, update the `instructions` string *and* the table in `README.md`.
- Meta keys must match `[a-zA-Z0-9_]+`. The emitter silently drops keys that don't, but prefer not to relying on that.
- Keep this a single file. If you find yourself wanting to split modules, reconsider — the whole thing is intentionally small.
