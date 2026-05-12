# pr-watcher

A [Claude Code channel](https://code.claude.com/docs/en/channels) that watches the pull request on your current branch and pushes change events into the running session. CI flips, new reviews, inline comments, fresh commits — Claude sees them as they happen and can react with the tools it already has (`gh`, file edits, etc.).

```
<channel source="pr-watcher" kind="ci_status" pr="482" check="test"
         state="FAILURE" bucket="fail" url="https://github.com/...">
Check "test": FAILURE — https://github.com/acme/api/actions/runs/1234567
</channel>
```

No reply tool, no opinionated playbook baked in. The watcher stays factual; project-specific behavior lives in a skill inside your project (see [Install in another project](#install-in-another-project)).

## What it watches

For the PR associated with the current branch:

- New commits to the head ref
- CI check transitions (`queued` → `in_progress` → `success` / `failure` / …)
- Reviews (`approved` / `changes_requested` / `commented`)
- Inline review comments
- Top-level PR comments
- PR state changes (closed / merged)
- Mergeability changes (merge conflict appeared / resolved)
- Merge state changes (PR falls behind base, becomes blocked, becomes clean, etc.)
- Branch swap to a different PR (or to a branch with no PR)
- A PR being opened on the branch the watcher is already on

Polling cadence adapts to what's going on:

| state                       | poll every |
| --------------------------- | ---------- |
| any check is `pending`      | 15 s       |
| PR exists, all checks done  | 60 s       |
| current branch has no PR    | 60 s       |

State is in-memory only. On startup (or after switching PRs, or when a PR appears on the watched branch) the watcher snapshots current state and emits `startup` / `pr_changed` / `pr_opened` — it does **not** backfill events for items that already exist.

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- [GitHub CLI](https://cli.github.com) authenticated (`gh auth status`)
- Claude Code v2.1.80+

## Install

```bash
git clone https://github.com/defrex/pr-watcher
cd pr-watcher
bun install
```

## Use it in this repo

There's already an `.mcp.json` here, so just start Claude Code from this directory:

```bash
claude --dangerously-load-development-channels server:pr-watcher
```

The `--dangerously-load-development-channels` flag is required during the channels research preview — custom channels aren't on the official Anthropic allowlist yet.

## Install in another project

The fastest path is the bundled init skill. From inside this repo, symlink the skill into your global skills dir:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/pr-watcher-init" ~/.claude/skills/pr-watcher-init
```

Then `cd` into the target project and run `/pr-watcher-init` in Claude Code. It will:

1. Add a `pr-watcher` entry to the project's `.mcp.json` pointing at this checkout.
2. Scaffold `.claude/skills/pr-watcher/SKILL.md` with a default event-handling playbook you can edit and commit.

If you'd rather wire it up by hand, add this to the target repo's `.mcp.json` with an absolute path:

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

Either way, start sessions with:

```bash
claude --dangerously-load-development-channels server:pr-watcher
```

## Events

All events arrive in Claude's context as `<channel source="pr-watcher" kind="..." ...>` tags. The body is a short factual summary (or the included text for comments and reviews).

| kind             | when                                            | meta                                    |
| ---------------- | ----------------------------------------------- | --------------------------------------- |
| `startup`        | watcher started and detected a PR               | `pr`, `repo`, `head_sha`, `url`         |
| `no_pr`          | current branch has no open PR (announced once)  | `branch`                                |
| `pr_opened`      | a PR appeared on the watched branch after `no_pr` | `pr`, `repo`, `head_sha`, `url`       |
| `pr_changed`     | branch swapped to a different PR                | `pr`, `prev_pr`, `repo`, `head_sha`     |
| `commits_pushed` | head ref moved                                  | `pr`, `old_sha`, `new_sha`, `url`       |
| `ci_status`      | a check changed state                           | `pr`, `check`, `state`, `bucket`, `url` |
| `review`         | a new review                                    | `pr`, `author`, `state`, `url`          |
| `review_comment` | a new inline review comment                     | `pr`, `author`, `path`, `line`, `url`   |
| `issue_comment`  | a new top-level PR comment                      | `pr`, `author`, `url`                   |
| `pr_state`       | PR state changed (e.g. closed / merged)         | `pr`, `state`, `url`                    |
| `mergeable`      | mergeability changed (conflict appeared/resolved) | `pr`, `mergeable`, `url`              |
| `merge_state`    | merge state changed (e.g. `CLEAN`→`BEHIND`, `BEHIND`→`DIRTY`) | `pr`, `state`, `prev_state`, `mergeable`, `url` |

The watcher does **not** tell Claude how to react. If you want behavior like *"when CI fails, pull the failing logs and try a fix"*, encode it in a project-level skill or `CLAUDE.md`. The init skill scaffolds a starting point.

## Design notes

- **One-way channel.** No tools, no reply mechanism. Claude already has `gh` and shell access — it doesn't need a custom "respond to review" tool.
- **Auto-detect from current branch.** Re-checked every tick, so `git checkout` is picked up naturally. No flags, no config.
- **Lean on `gh`.** No octokit, no token plumbing — `gh` already handles auth.
- **Single PR at a time, no persistence.** Bootstrap-on-start is simpler than a state file and good enough.

## Debugging

- `/mcp` inside the session shows whether the server connected.
- Connection failures land in `~/.claude/debug/<session-id>.txt`.
- The script logs to stderr with prefix `[pr-watcher]`.

Smoke test (no Claude Code needed) — should print one notification, then hang:

```bash
( bun ./pr-watcher.ts < /dev/null & PID=$!; sleep 2; kill $PID ) 2>&1
```

## License

MIT
