---
name: pr-watcher-init
description: Install the pr-watcher Claude Code channel into the current project. Adds an .mcp.json entry pointing at the user's pr-watcher checkout and scaffolds a project-level /pr-watcher skill containing default handling for CI failures, reviews, and comments. The project skill is meant to be edited and committed for per-project customization.
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash
---

Install the pr-watcher channel into the current working directory.

Two artifacts produced:

1. **MCP server entry** in the project's `.mcp.json` so Claude Code can spawn the watcher when the user passes `--dangerously-load-development-channels server:pr-watcher`.
2. **Project-level `/pr-watcher` skill** at `.claude/skills/pr-watcher/SKILL.md` containing a default playbook for handling channel events. The user can edit this for project-specific behaviour.

## Step 1 — Resolve the watcher script path

This skill lives inside the pr-watcher repo, at `<repo>/skills/pr-watcher-init/SKILL.md`. The watcher script is therefore two directories up from this skill, named `pr-watcher.ts`. The base directory of this skill was given to you in the slash-command system message ("Base directory for this skill: …"). Resolve the watcher path:

```bash
SKILL_DIR="<base directory from the system message>"
WATCHER="$(realpath "$SKILL_DIR/../../pr-watcher.ts")"
```

Verify it exists. If not, stop and tell the user the pr-watcher repo is missing or this skill was placed somewhere unexpected — they need to clone https://github.com/defrex/pr-watcher (or wherever they keep it) and re-symlink this skill from inside that repo's `skills/` dir.

## Step 2 — Verify prerequisites

Run quick checks. If any fail, print what's missing and abort:

- `command -v bun` — required runtime for the watcher.
- `command -v gh` and `gh auth status` — required for GitHub access.
- `git rev-parse --is-inside-work-tree` — current directory should be a git repo.
- The watcher repo's `node_modules` should exist (`test -d "$(dirname "$WATCHER")/node_modules"`). If not, run `bun install` in that directory before continuing.

## Step 3 — Add or update `.mcp.json`

Target: `<cwd>/.mcp.json`. Use the absolute `$WATCHER` path.

- **If `.mcp.json` doesn't exist**, create it:
  ```json
  {
    "mcpServers": {
      "pr-watcher": {
        "command": "bun",
        "args": ["<absolute path>"]
      }
    }
  }
  ```
- **If it exists**, parse it and merge. Don't clobber other servers. Use `jq` for the merge so formatting stays valid:
  ```bash
  tmp=$(mktemp)
  jq --arg path "$WATCHER" \
    '.mcpServers["pr-watcher"] = {command:"bun", args:[$path]}' \
    .mcp.json > "$tmp" && mv "$tmp" .mcp.json
  ```
- If `pr-watcher` is already present in `.mcp.json` with a different path, update it to the resolved `$WATCHER` path and tell the user you did so.

## Step 4 — Scaffold the project-level `/pr-watcher` skill

Path: `<cwd>/.claude/skills/pr-watcher/SKILL.md`.

- Make the directory: `mkdir -p .claude/skills/pr-watcher`.
- **If the SKILL.md already exists, do not overwrite it.** Tell the user it's already present and that their customizations were preserved. Skip writing.
- Otherwise, write the file with this exact content:

````markdown
---
name: pr-watcher
description: Handle events from the pr-watcher channel — CI status changes, reviews, and comments on the current PR. Loaded when channel events arrive or when the user invokes /pr-watcher. Edit freely for project-specific behaviour.
---

# pr-watcher (project playbook)

This project has the [pr-watcher](https://code.claude.com/docs/en/channels) channel configured in `.mcp.json`. While a session has the watcher running, change events on the current PR arrive in your context as `<channel source="pr-watcher" kind="..." ...>` tags.

## Starting a session with the watcher

```bash
claude --dangerously-load-development-channels server:pr-watcher
```

The flag is required during the channels research preview because pr-watcher is a custom channel, not on the official Anthropic allowlist.

## Default event handling

These are the defaults — edit them to fit this project. Only act on events while the user has signalled they want autonomous PR work; otherwise just acknowledge what arrived and wait.

### `ci_status` with `bucket=fail`

A check failed.

1. Read the failure. The `url` meta points at the run; pull failing logs with `gh run view <run-id> --log-failed`.
2. Identify the root cause (failing test, type error, lint, build, etc.).
3. Reproduce locally when practical.
4. Fix the root cause. Don't disable tests or weaken assertions to make CI pass — if the test is genuinely wrong, say so explicitly.
5. Commit with a message that names what failed and why the fix works. Push.

### `ci_status` with `bucket=pass`

If the same check was previously failing in this session, mention that it's now green. Otherwise no action.

### `review` (state=`CHANGES_REQUESTED` or `COMMENTED`)

A reviewer submitted a review.

1. Read the body. Look at the inline `review_comment` events that follow (or arrived) for line-level feedback.
2. Triage: actionable code change, question, nit, or out-of-scope.
3. Apply code changes; commit and push.
4. For questions where the answer requires prose, reply with `gh pr comment <pr> --body "..."`. Where the answer is "yes the code should change", just change it — the diff is the answer.
5. For out-of-scope feedback, leave a comment acknowledging and deferring.

### `review` (state=`APPROVED`)

Informational. Don't do anything unless the user asked you to merge.

### `review_comment`

Inline review comment. `path` and `line` meta point at the location.

1. Open that file at that line.
2. Address the comment as above.

### `issue_comment`

Top-level PR comment. Often a teammate question or status nudge. Same triage as reviews.

### `commits_pushed`

Head ref moved.

- If you just pushed, no action.
- If someone else pushed, `git pull --rebase` and re-orient. Any work in flight may need to be redone on top of the new tip.

### `pr_state` (`MERGED` or `CLOSED`)

Stop reacting to further events on this PR. If you have local work in progress, stash or commit it and tell the user.

### `pr_changed` / `no_pr` / `startup`

Informational. These tell you which PR (if any) is currently being watched. Update your mental model.

## Project conventions

<!-- Add project-specific norms here. Examples:

- Which checks are required vs. advisory.
- Which reviewers' feedback blocks merge.
- How to reproduce CI locally for this repo.
- Where logs / dashboards live.
- Conventions for commit messages addressing review feedback.

-->
````

## Step 5 — Report

After both writes, print to the user:

```
pr-watcher installed.

  .mcp.json                          # added pr-watcher server entry
  .claude/skills/pr-watcher/SKILL.md  # default event-handling playbook

Start a session with the watcher enabled:
  claude --dangerously-load-development-channels server:pr-watcher

Edit .claude/skills/pr-watcher/SKILL.md to encode project-specific norms.
```

## Notes

- Do not `git add` or commit anything. Let the user decide what to track. Mention that both files are typically committed so collaborators get the same setup.
- If `.mcp.json` already had a `pr-watcher` entry pointing at the same path you just resolved, that's a re-run — say "already installed" and skip step 3.
- If anything fails midway, leave the partial state for the user to inspect rather than rolling back silently.
