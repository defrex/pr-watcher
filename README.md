# pr-watcher

A Claude Code [channel](https://code.claude.com/docs/en/channels) that watches the currently checked-out pull request and pushes change events into your running session. The agent reacts using the tools it already has — `gh`, file edits, etc. Project-specific handling can live in skills inside the project; this watcher stays factual.

## What it watches

For the PR associated with the current branch:

- New commits to the head ref
- CI check transitions (queued → in_progress → success/failure/...)
- Reviews (approved / changes_requested / commented)
- Inline review comments
- Top-level PR comments
- PR state changes (closed/merged)
- Branch swap to a different PR (or to a branch with no PR)

Polling cadence adapts:

- **15s** while any check is `pending`
- **60s** when checks are settled
- **5min** when the current branch has no PR

State is in-memory only. On startup (or after switching PRs) the watcher captures the current state and emits `startup` / `pr_changed` — it does **not** backfill events for items that already exist.

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- [GitHub CLI](https://cli.github.com) (`gh`) authenticated (`gh auth status`)
- Claude Code v2.1.80+

## Install

```bash
git clone <this repo> pr-watcher
cd pr-watcher
bun install
```

## Use it in this project

There's already an `.mcp.json` here, so just start Claude Code from this directory:

```bash
claude --dangerously-load-development-channels server:pr-watcher
```

(During the channels research preview, custom servers need that flag.)

## Use it in another project

Two options:

### A. Per-project `.mcp.json`

Add this to the target repo's `.mcp.json`, with an absolute path to the script:

```json
{
  "mcpServers": {
    "pr-watcher": {
      "command": "bun",
      "args": ["/absolute/path/to/pr-watcher/pr-watcher.ts"]
    }
  }
}
```

Then start Claude Code in that repo with:

```bash
claude --dangerously-load-development-channels server:pr-watcher
```

### B. User-level config

Add the same `mcpServers` block to `~/.claude.json` (using an absolute path) so it's available in every project. You still need to opt the channel into each session with `--dangerously-load-development-channels server:pr-watcher`.

## Events

All events arrive in Claude's context as `<channel source="pr-watcher" kind="..." ...>` tags. The body is a short factual summary (or the included text for comments/reviews). `kind` values:

| kind             | when                                                | key meta                                |
| ---------------- | --------------------------------------------------- | --------------------------------------- |
| `startup`        | watcher starts and detects a PR                     | `pr`, `repo`, `head_sha`, `url`         |
| `no_pr`          | current branch has no open PR (announced once)      | `branch`                                |
| `pr_changed`     | branch swapped to a different PR                    | `pr`, `prev_pr`, `repo`, `head_sha`     |
| `commits_pushed` | head ref moved                                      | `old_sha`, `new_sha`, `pr`, `url`       |
| `ci_status`      | a check changed state                               | `check`, `state`, `bucket`, `url`, `pr` |
| `review`         | a new review                                        | `author`, `state`, `url`, `pr`          |
| `review_comment` | a new inline review comment                         | `author`, `path`, `line`, `url`, `pr`   |
| `issue_comment`  | a new top-level PR comment                          | `author`, `url`, `pr`                   |
| `pr_state`       | PR `state` field changed (e.g. closed/merged)       | `state`, `pr`, `url`                    |

This watcher does **not** tell Claude how to react. If you want project-specific behaviour ("when CI fails, run the failing test locally and try a fix"), put that in a skill or `CLAUDE.md` in your project.

## Debugging

- `/mcp` inside the session shows whether the server connected.
- Connection failures are logged to `~/.claude/debug/<session-id>.txt`.
- The script logs to its own stderr with the prefix `[pr-watcher]`.

## License

MIT
