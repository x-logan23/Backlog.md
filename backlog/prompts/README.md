# Agent prompt templates

Drop-in templates for running a coder ↔ reviewer ↔ human-review loop on top of Backlog.md's `onStatusChange` hook.

## What's here

| File | When it runs | What the agent does |
|------|--------------|---------------------|
| `code.md` | Task → `In Progress` | Reads the task, implements it (initial work or reviewer rework), records notes, moves to `In Review`. Handles merge conflicts inline. |
| `review.md` | Task → `In Review` | Audits the diff against acceptance criteria + DoD, writes structured findings into the task, moves to either `In Progress` (rework) or `Human Review` (approved). |
| `ready.md` | Task → `Human Review` | Optional notifier. Prints a one-screen summary into the log file. Extend it if you want Slack/email notifications. |
| `dispatch.ps1` | All of the above (Windows) | Picks the prompt file by `$NEW_STATUS`, prepends task context, launches `claude -p` in the background. Also strips `ANTHROPIC_API_KEY` (forces subscription auth), scopes MCP servers per role, records token usage, and creates the MR on Human Review. |
| `dispatch.sh` | All of the above (POSIX) | Same core loop and the same three guards, for `sh` / `bash`. Uses `set -C` (noclobber) for the atomic claims the Windows version gets from `File::Open CreateNew`. |
| `token-report.ps1` | After a coder/reviewer session ends (Windows) | Reads the finished session's token usage out-of-band from its transcript; appends to `logs/tokens.csv` and a per-task line. Zero extra agent tokens. |
| `watchdog.ps1` | On a timer (Windows) | Nothing else notices when a dispatched agent *process* dies — a provider limit, a crashed MCP subprocess, a machine hiccup — and the task then sits in `In Progress` forever with nothing behind it. Run it from Task Scheduler every ~10 min: it finds those and re-fires the dispatcher. Stateless apart from per-task retry markers. |
| `create-mr.ps1` | Task → `Human Review` (Windows, GitLab) | Deterministic, idempotent GitLab MR creation. Needs `GITLAB_PROJECT_ID` (skips cleanly when unset, e.g. GitHub) and a token via `GITLAB_TOKEN` / `.mcp.json` / codex config. |
| `logs/` | (created on first run) | Per-invocation logs (`<timestamp>-<task_id>-<status>.log` plus `.err` for stderr). Inspect these when a hook misbehaves. |

## The three guards

Both dispatchers share these, and each exists because of a specific failure:

- **Dedup lock** (90 s, keyed on `(taskId, status)`) — the hook can fire more than once for one event when the in-process dispatch and the file watcher race. The key deliberately carries **no timestamp**: an earlier version embedded the current second, so two dispatches seconds apart hashed differently, both launched, and two agents attached to one worktree and wrote two parallel implementations of the same feature.
- **Ping-pong loop guard** (`.hop-NNN` claims, max 6) — the dedup lock does nothing about a task bouncing coder → reviewer → coder forever, each hop legitimate. One task did exactly that and burned two 5-hour provider windows before anyone noticed. Hops are claimed atomically because a read-increment-write counter loses updates under a hook storm (17 fires for one status change has been observed). A watchdog restart (`OLD_STATUS == NEW_STATUS`) deliberately does **not** consume a hop — this counts disagreement, not crashes.
- **Log retention** (14 days) — nothing used to prune `logs/`, and one deployment reached 48,967 files / 727 MB after a retry storm wrote 29,720 files in a day.

Reset a fenced task with `rm backlog/prompts/logs/<TASK-ID>.hop-*` (or the PowerShell equivalent) once you've re-scoped, reassigned, or split it.

## Optional: an automated test gate (`Testing`)

Both dispatchers understand a `Testing` status between `In Progress` and `In Review`, so a suite runs on every branch before a reviewer ever looks at it. It is **opt-in and off by default**, because a `Testing` column with nothing behind it strands every task that enters it. To turn it on:

1. add `"Testing"` to `statuses:` in `backlog/config.yml`, between `In Progress` and `In Review`;
2. drop a `run-full-suite.ps1` (Windows) or `run-full-suite.sh` (POSIX) next to the dispatcher;
3. change your `code.md` so the coder's terminal state is `Testing`, not `In Review`.

No runner ships here — it has to know how your suite boots. What it must honour is the contract:

| | |
|---|---|
| **Invoked as** | `run-full-suite.ps1 -TaskId <id> -ProjectRoot <path>` · `run-full-suite.sh <taskId> <projectRoot>` |
| **Runs** | detached, for as long as it needs — the dispatcher does not wait, and no agent session is blocked on it |
| **On success** | move the task to `In Review` and append a pass summary |
| **On failure** | move it back to `In Progress`, with the failing part and a log excerpt in the notes |
| **Annotating only** | append notes *without* a status change, so a note can never re-trigger the hook |

A red run landing the task back in `In Progress` is recognised by its `OLD_STATUS=Testing` signature and **resumes the coder's existing session** rather than starting a fresh one that has never seen the failure.

If the status fires with no runner present, the dispatcher warns loudly and stops rather than passing silently — a silent skip is indistinguishable from a green gate.

## Prerequisites

1. **Claude Code CLI on PATH** — `claude --version` should work in the shell the dispatcher uses. The dispatchers run `claude -p <prompt> --dangerously-skip-permissions` headless. Drop `--dangerously-skip-permissions` from the dispatcher if you'd rather review every tool call (each hook fire will then block waiting for your input — defeats the point of the loop).
2. **Backlog.md MCP server registered with Claude Code:**
   ```
   claude mcp add backlog --scope user -- backlog mcp start
   ```
   The prompts assume this is available; the agents use it to read and write task state.
3. **Required statuses in `backlog.config.yml`:**
   ```yaml
   statuses: ["To Do", "In Progress", "In Review", "Human Review", "Done"]
   ```
   The default Backlog.md install only has `To Do`, `In Progress`, `Done`. Add the two extras or rename the dispatcher's `case` branches to match your conventions.

## Installation

In your project's `backlog.config.yml`:

**Windows (PowerShell):**

```yaml
shell: "powershell"
onStatusChange: 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PWD\backlog\prompts\dispatch.ps1"'
```

> **Why `-ExecutionPolicy Bypass`?** Windows ships with `Restricted` as the default `CurrentUser` execution policy, which refuses to run unsigned local `.ps1` files. The flag scopes the bypass to this single invocation — no global config change required. If you'd rather flip the policy once and use the shorter form `'& "$PWD\backlog\prompts\dispatch.ps1"'`, run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` in any PowerShell window (no admin needed).

**POSIX (sh/bash):**

```yaml
shell: "sh"
onStatusChange: '"$PWD/backlog/prompts/dispatch.sh"'
```

Then change a task's status (drag it on the kanban, edit it via CLI, or move it via MCP) and the corresponding agent fires.

## Code hosting & merge/pull requests

When a task reaches `Human Review`, the loop opens a merge request for the task's
implementation branch. This happens two ways, and both are optional:

1. **The reviewer agent** (`review.md`, Step 6) opens it through whatever code-host
   MCP server is wired into `.claude/mcp-reviewer.json`.
2. **`create-mr.ps1`** opens it deterministically from the dispatcher as a backstop,
   so an approved task still gets its MR even if the agent forgets.

### Environment variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `GITLAB_PROJECT_ID` | `watchdog.ps1` | On a timer (Windows) | Nothing else notices when a dispatched agent *process* dies — a provider limit, a crashed MCP subprocess, a machine hiccup — and the task then sits in `In Progress` forever with nothing behind it. Run it from Task Scheduler every ~10 min: it finds those and re-fires the dispatcher. Stateless apart from per-task retry markers. |
| `create-mr.ps1` | Numeric project id. **If unset, MR creation is skipped entirely** (the reviewer agent's own step still runs). |
| `GITLAB_TOKEN` | `create-mr.ps1`, `mcp-reviewer.json` | API token. Falls back to `.mcp.json` → `~/.codex/config.toml` if the env var is absent. |
| `GITLAB_TARGET_BRANCH` | `watchdog.ps1` | On a timer (Windows) | Nothing else notices when a dispatched agent *process* dies — a provider limit, a crashed MCP subprocess, a machine hiccup — and the task then sits in `In Progress` forever with nothing behind it. Run it from Task Scheduler every ~10 min: it finds those and re-fires the dispatcher. Stateless apart from per-task retry markers. |
| `create-mr.ps1` | Target branch for the MR. Defaults to `main`. |

The `.claude/mcp-reviewer.json` scaffolded by `backlog init` references the token as
`${GITLAB_TOKEN}` — set the env var, don't hardcode the secret into the committed file.

### Using GitHub, Bitbucket, or another host

The naming above is GitLab-flavored because `create-mr.ps1` talks to the GitLab REST
API directly, but nothing about the loop is GitLab-specific. To target a different host,
pick whichever fits:

- **Let the agent do it (host-agnostic, no script changes).** Swap the `gitlab` entry in
  `.claude/mcp-reviewer.json` for your host's MCP server (e.g. a GitHub MCP server), update
  `review.md` Step 6 to say "open a pull request" instead of "merge request", and leave
  `GITLAB_PROJECT_ID` unset so `create-mr.ps1` no-ops. This is the simplest path.
- **Keep the deterministic backstop.** Copy `create-mr.ps1` to e.g. `create-pr.ps1`, point
  `Invoke-RestMethod` at your host's API (GitHub: `POST /repos/{owner}/{repo}/pulls` with an
  `Authorization: Bearer` header; Bitbucket: `POST .../pullrequests`), and swap the call in
  `dispatch.ps1`'s Human Review block. The branch-resolution and idempotency logic ports as-is.

Either way the rest of the loop — coder, reviewer, statuses, token accounting — is unchanged.

## Trying it out

```
# Move a task to In Progress — should fire the coder.
backlog task edit BACK-NN --status "In Progress"

# Watch the dispatcher log.
# Windows:   Get-Content -Wait .\backlog\prompts\logs\*.log
# POSIX:     tail -f backlog/prompts/logs/*.log
```

### Smoke-test mode (no-op agents)

To verify the wiring without burning API tokens on real coder/reviewer runs, set `BACKLOG_DISPATCH_MODE=test` in the env that launches the Backlog.md server. The dispatcher will pick `code.test.md` and `review.test.md` instead of the real prompts. The test agents simply wait ~10 seconds and then transition the task to the next status — `In Progress → In Review → Human Review` — so you can watch the whole loop fire end-to-end.

**Windows:**

```powershell
$env:BACKLOG_DISPATCH_MODE = 'test'
bun run cli browser
```

**POSIX:**

```sh
BACKLOG_DISPATCH_MODE=test bun run cli browser
```

Unset the variable (or restart the server) to go back to real agents.

If the log is empty after a status change, check:
- The Backlog.md server stderr for "Status change callback failed for …" lines.
- That `shell` in `backlog.config.yml` matches an installed interpreter (Settings → Status Change Callback in the browser will flag missing shells).
- That the prompt file the dispatcher chose actually exists (`code.md` / `review.md` / `ready.md`).

## Customizing

- **Edit the prompts** — they're plain markdown. Add project-specific conventions, point at internal docs, change the verdict thresholds. Each round of running the loop will surface improvements.
- **Per-task overrides** — set `onStatusChange:` on an individual task's frontmatter (or via the modal's "Advanced" section in the browser) to bypass the dispatcher for one task. Useful when a single task needs a different agent or no agent at all.
- **Add new transitions** — add a `case` to the dispatcher and a new `<status>.md` file. The convention is: prompt filename = lowercase status with spaces collapsed.
- **Different agents** — replace `claude` in the dispatcher with whatever CLI binary you want (`codex`, `gemini`, etc.). The prompt format is generic markdown; only the MCP-tool calls in the prompts assume Backlog.md MCP is reachable.

## Per-invocation log files

Each hook fire writes two files under `logs/`:

- `<timestamp>-<task_id>-<status>.log` — claude's stdout (the agent's reasoning + final answer)
- `<timestamp>-<task_id>-<status>.log.err` — claude's stderr

These are not rotated automatically. Either prune them manually, add `backlog/prompts/logs/` to `.gitignore`, or wire up a cron / scheduled task to clean files older than N days.
