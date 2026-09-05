# context.md — live agent panel work (session of 2026-09-02/04)

Working notes for whoever picks this branch up next. `FORK_CONTEXT.md` is still the
best account of *why the fork exists* and how the hook/watcher machinery was
originally built; this file covers what changed on top of it, what turned out to
be wrong in it, and what is left.

Written in English to match the code, comments and commit messages;
`FORK_CONTEXT.md` is in Spanish and stays that way.

---

## Where things stand

| | |
|---|---|
| Branch | `feat/live-agent-panes`, **12 commits, pushed, NOT merged** |
| Base | `origin/main` = `b5ad734` (branch is 0 behind) |
| Repo path | `D:\1064n\Programacion\claude\Backlog.md` |
| PR | https://github.com/x-logan23/Backlog.md/pull/new/feat/live-agent-panes |

> ⚠️ `FORK_CONTEXT.md` says the real repo is `Backlog.md` and that
> `Backlog.md with agents` is a second, git-less copy. Still true — but note the
> volume is **case-insensitive**, so `backlog.md` and `Backlog.md` are the *same*
> directory (verified by inode). Only `Backlog.md with agents` is genuinely
> separate, and it does **not** have this work.

```
de12b1c feat: move auto-scroll to a per-pane "follow" toggle
6088582 fix: move the auto-scroll toggle beside the panel's other controls
bdff5b6 style: stack agent event labels so the detail gets the full pane width
227c2cc feat: auto-scroll toggle for the live agent panes
04a6289 style: let the kanban board use the full window width
453f38b feat(prompts): optional Testing gate so a suite runs before review
bb0c24c fix(prompts): port the dispatcher's reliability guards from the live deployment
e3d5d2f style: give kanban cards the live agent panel's card language
ff1b5eb fix: honour legacy watcher locks so an upgrade cannot double-dispatch
089e2d3 fix: stale watcher lock no longer freezes a server's task cache
1fbf9b3 fix: stop the card spinners trusting a recycled pid
034c368 feat: live agent activity panel on the board
```

---

## What was built

### 1. Live agent panel (`034c368`)

A board-level view of every agent the dispatcher currently has out, above the
kanban. Answers "what is each agent doing right now, and is any of them stuck?"
without opening anything.

- **`src/core/agent-activity.ts`** — pure parsers, no filesystem, unit-testable.
  Normalizes three unequal feeds into one `AgentEvent` stream, plus
  `AgentFeedTail`, an incremental tailer.
- **`/api/agent-activity`** (`src/server/index.ts`) — one request returns every
  active dispatch with events, tokens, elapsed and hop count.
- **`src/web/components/LiveAgentPanel.tsx`** + `src/web/hooks/useAgentActivity.ts`
  — polls every 3s.

**The feeds are not equivalent, and this is the load-bearing detail:**

| agent | source | why |
|---|---|---|
| codex | its dispatch log | launched with `exec --json`, so the log is already NDJSON |
| **claude** | **`~/.claude/projects/<slug>/<sessionId>.jsonl`** | launched with plain `-p`, whose stdout is only the closing prose — no tool calls, no usage. The session transcript is the real record (the same file `token-report.ps1` reads) |
| opencode | its dispatch log, as plain text | emits neither |

Session ids come from the task's `## Session` block. Transcripts pass 10 MB, so
the server keeps a byte offset per feed and each poll parses only what was
appended; a first attach to an already-huge file seeks to the last 8 MB and flags
the totals `tokensPartial` rather than reporting a confident wrong number.

### 2. Liveness: a live PID proves nothing (`1fbf9b3`)

`/api/agent-status` decided "running" from `process.kill(pid, 0)` alone. Windows
recycles PIDs and the `.pid` files outlive their agents by days. Measured
2026-09-02 on the kiero-app project — all four "running" dispatches:

| PID | actually was | started | dispatch was |
|---|---|---|---|
| 36384 | `node` | Sep 2, 22:25 | Sep 2, 20:51 |
| 51100 | `bash` | Aug 30, 16:24 | Aug 29, 23:02 |
| 33152 | `chrome` | Sep 2, 22:26 | Aug 31, 01:56 |
| 34668 | `FileCoAuth` | Sep 2, 08:20 | Aug 31, 10:24 |

`isLikelyRunning()` now requires three things: the pid resolves, the task is
**still in the status the dispatch was launched for**, and the feed produced
output recently (15 min grace). `deriveBadgeState()` collapses that into one of
three states, shared by the card badges and the panel so they cannot disagree.

**"pid alive but silent" gets its own amber state**, deliberately — it is the
stranded-session signature, and calling it "done" hides the one case needing a
human.

> `project_state.md` rev 38 (kiero-app memory) lists "the agent dashboard reports
> false strandings" as an open failure mode. **That is this bug, and it is fixed
> here** — but only once this branch ships.

### 3. Watcher lock (`089e2d3`, `ff1b5eb`) — FORK_CONTEXT.md is out of date here

`FORK_CONTEXT.md` §3 describes `watcher-lock.ts` as `proper-lockfile` with
`onCompromised` / `staleMs: 30_000` / `updateMs: 8_000`. **That is no longer
true.** It had already been rewritten as a PID file, and this branch changed it
again. `proper-lockfile` now appears only in comments explaining what it is *not*.

Two defects, one symptom (a server serving hours-old task data):

1. **The lock could not be reclaimed after a force-kill**, for the same
   PID-reuse reason as above. The holder now rewrites the file on a 30s interval
   with a fresh timestamp; a live pid behind a >2 min timestamp reads as stale.
2. **Deferring dispatch also switched off file watching**, which was what kept
   the `ContentStore` fresh. Watching and dispatching are separate jobs and only
   the second may be duplicated. Watchers now stay on for non-authority servers,
   and suppression moved into the dispatcher behind an `isAuthority` gate.

**The gate is checked last, only for a write that would otherwise fire.**
Resolving authority can acquire the lock, so asking before the cheap
early-returns made the bulk-refresh path take a lock for writes that were never
going to fire anything — that alone cost 2 extra CLI test timeouts.

**Lock file format is versioned by shape, for upgrade safety:**

```
27604              <- legacy: pid only, written by a build with no heartbeat
27604
hb=1788412345678   <- current
```

A missing heartbeat means a legacy writer owns it, and it is honoured under the
old pid-only rule. This is not theoretical: two pre-upgrade servers were found
running with 15- and 17-day-old lock files, and applying the staleness rule to
those would have evicted two healthy servers and left two processes both
dispatching `onStatusChange`. The pid stays alone on line 1 so an older build
still parses it.

Residual: a *killed legacy* holder still blocks forever (today's behaviour).
`rm backlog/.locks/watcher.pid` clears it; cannot recur once everything writes
the current format.

### 4. Dispatcher guards ported from the live deployment (`bb0c24c`)

`backlog init` ships `backlog/prompts/` verbatim, so every new project inherited
whatever was here — and what was here predated every incident the guards prevent.
**The dedup guard was actively wrong, not merely missing**: it keyed the lock on
the current second, so two dispatches seconds apart hashed differently and both
launched, putting two agents on one worktree.

Now in both dispatchers: dedup keyed `(taskId, status)` with age-based staleness;
TOCTOU-safe stale-lock check; ping-pong loop guard (atomic `.hop-NNN`, max 6, and
a watchdog restart deliberately does **not** consume a hop); 14-day log retention;
evidence-based stranded resume (resume only on a provider-limit signature in the
previous log's tail — otherwise a clean exit that believed itself finished gets
its false belief reproduced).

**`watchdog.ps1` was missing entirely** and is now shipped by `init`. It is the
only thing that notices a dead agent *process*; `dispatch.ps1` is event-driven and
exits.

**`dispatch.sh` had no dedup guard at all** — the POSIX path was completely
unprotected. It now carries all three guards, using `set -C` (noclobber) for the
atomic claim the Windows version gets from `File::Open CreateNew`.

### 5. Optional `Testing` gate (`453f38b`)

`Testing` previously fell through to "status we don't dispatch on", so the
five-stage pipeline the README describes could not run its test stage.

**Opt-in, and deliberately not in the default statuses** — a `Testing` column with
no runner strands every task that enters it. No runner ships (the one this came
from is 561 lines of Docker and Laravel); the *contract* ships, documented in
`backlog/prompts/README.md`. A missing runner **warns loudly and stops**, because
silence is indistinguishable from a passing gate.

### 6. UI (`e3d5d2f`, `04a6289`, `bdff5b6`, `227c2cc`, `6088582`, `de12b1c`)

Kanban cards adopted the panel's card language (header strip / body / footer
bands, shell has no padding of its own). Board is full-bleed — Tailwind's
`container` capped it at 96rem and centred it. Event rows stack label-over-detail
instead of a fixed 6rem label column that was both mostly empty and truncating.
Each pane has its own `follow` checkbox.

Two traps worth remembering, both already hit:

- **Auto-scroll must not disengage on the scroll event itself.** Our own
  scroll-to-bottom fires `onScroll`, so "any scroll turns it off" unticks the box
  the instant an event arrives. Infer from *being left away from the bottom*.
- **The re-pin effect cannot key on `events.length`.** The feed is a ring buffer
  capped at 40; once a busy pane fills, length stops changing while content keeps
  moving, so it would stop following exactly the agent worth watching.

---

## Environment facts that cost time

- **The dev server bundles at startup.** A browser reload alone never shows a code
  change — restart the server. To update the global binary:
  `bun run build && bun run install:local`, then restart. Running straight from
  source always reflects the checkout:
  `bun run <fork>/src/cli.ts browser --port 6499 --no-open`.
- **`bun test` is red at 416 failures on Windows at `b5ad734`, before any of this
  work.** Verified by stashing and running a clean checkout: identical count.
  `FORK_CONTEXT.md` says ~488; 416 is the current measurement. Judge a change by
  **diffing failing test names**, not the count — churn inside
  `CLI Priority Filtering` is timeout flake and moves run to run.
- **The suite writes into the working tree** — it modifies `src/web/styles/style.css`
  and creates `backlog/docs/doc-4 - No-Git-Doc.md`. Enough to break `git stash pop`
  mid-work. Clean those before committing.
- **`biome check` fails on `src/server/index.ts` and `task-hook-dispatcher.ts` at
  HEAD too**: the repo stores LF, Windows checks out CRLF. Pre-existing; do not
  "fix" it with a reformat. Note biome's `files.includes` is `src/**/*.ts` — it
  does **not** cover `.tsx`.
- **Never start a second `backlog browser` against the kiero-app project while its
  loop is live.** Multiple servers each firing `onStatusChange` is the documented
  17-fires-for-one-change storm. Test against a scratch fixture instead.

---

## What is left

**Known gaps, none blocking:**

1. **The panel has never been reviewed in a browser by a person.** Its data is
   verified end-to-end, but the playwright MCP failed to connect for this whole
   session, so every check was via the API and the served bundle. Layout is
   unproven beyond two user screenshots.
2. **`dispatch.sh` has no stranded-retry path.** Safe (it launches fresh) but a
   real feature gap versus `dispatch.ps1`. Left rather than written blind, since a
   resume path cannot be exercised without live agents.
3. **The 416-failure suite.** Its own body of work: triage by root cause first —
   a large share look like POSIX-shaped fixtures (`/bin/sh`, AF_UNIX binds), path
   separators and 5s subprocess timeouts, not 416 independent bugs.
4. **`package.json` is still `1.45.1`** (upstream's). A bump would let
   `backlog --version` distinguish the fork — carried over from
   `FORK_CONTEXT.md`'s list and still true.

**Ideas this work suggests:**

- **Hook-driven agent status.** Everything here infers state by reading files
  after the fact. Claude Code hooks (`Notification`, `PreToolUse`, `Stop`) could
  push status instead — that is how nodeterm drives its RUNNING / NEEDS YOU
  badges, and it is far more reliable than polling. `.claude/` in the managed
  project has no hooks configured today.
- **opencode is the weakest feed** and is the default coder in the deployment this
  came from. Its usage lives in `opencode.db` (sqlite) and `token-report.ps1`
  still records it as `pending`. Worth investigating whether `opencode serve`
  exposes an event stream.
- **Cycle metrics** — the dispatcher logs already carry the timestamps, and
  `tokens.csv` the cost.
