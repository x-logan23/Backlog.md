# context.md — working notes

Handoff notes, **newest session first**. `FORK_CONTEXT.md` is still the best
account of *why the fork exists* and how the hook/watcher machinery was
originally built; this file covers what changed on top of it, what turned out to
be wrong in it, and what is left.

Written in English to match the code, comments and commit messages;
`FORK_CONTEXT.md` is in Spanish and stays that way.

---

# Session of 2026-09-10 — multi-repo dispatch, web theming, CI

## Why this session happened

The fork is now used at Bankaya, a microservices shop: many small repos cloned
side by side, no monorepo. Running `backlog init` in each would scatter task
state across N repos and fragment the board. The goal was one hub backlog above
the repos, with each task naming the repo it targets, and the dispatcher running
the agent inside that repo.

## Where things stand

**Merged to `main`:**

- **#7 — multi-repo dispatch.** Optional `repo` field on tasks (types, markdown,
  Core, CLI `--repo` on create/edit/list, MCP create/edit/list, server, plain
  text), a card slot + Settings toggle + modal editor, and both dispatchers
  resolving the repo and running the agent inside it.
- **#8 — web theming.** `theme` config key naming
  `<backlogDir>/themes/<name>.css`, served at `GET /theme.css`.

**Open: #10 — CI lint + `install:local`.** Three commits, ready for review.

## The two things most worth knowing

### 1. Theming works because Tailwind v4 compiles to custom properties

Every utility resolves to a variable — `.bg-gray-50` is
`background-color: var(--color-gray-50)` — and the whole palette is declared on
`:root`. So a theme is *only* variable overrides and needs **no component
changes**. Read per request, so editing a palette needs a reload, not a rebuild.

Two non-obvious constraints, both already cost time once:

- **A theme file must stay unlayered.** Tailwind emits everything inside
  `@layer` (the palette lives in `@layer theme`), and unlayered CSS beats
  layered CSS *regardless of source order*. That is also why the injected
  `<link>` landing before the bundled stylesheet is fine, and why nobody should
  "fix" that ordering.
- **A static `<link href="/theme.css">` breaks the build.** Bun's HTML bundler
  resolves markup hrefs at build time and cannot resolve a runtime-only route.
  The link is injected by a head script instead.

### 2. CI has never run the test suite (fixed in #10, not yet merged)

`bun run lint` failed on one non-auto-fixable rule, and fail-fast then cancelled
the macOS and Windows jobs — so `bun test` never executed on any platform.
`compile-and-smoke-test` passing made it look partially healthy.

Fixing that immediately surfaced **two Linux-only dispatcher bugs**, both
pre-existing and both silent:

- `${BASH_SOURCE[0]}` is a bashism. `/bin/sh` is bash on macOS but **dash** on
  Debian/Ubuntu, which answers `Bad substitution` — leaving `script_dir` empty,
  `project_root` wrong, and the dispatcher exiting **0 having done nothing**.
  Since init writes `onStatusChange: 'sh ".../dispatch.sh"'`, the whole agent
  loop has been dead on Ubuntu for as long as the POSIX dispatcher existed.
- `set -o pipefail` is not POSIX; older dash exits **2** on it. This was hiding
  behind the first fix, which is why the first attempt did not clear CI.

Neither reproduces on macOS, and Homebrew's dash (0.5.13.5) is new enough to
have `pipefail`, so local testing cannot catch them either. There is now a
dash-guarded regression test. **Lesson: this script must be tested under dash,
not just `sh`.**

## Review findings from #7, worth not re-learning

A Windows review caught two real holes:

- **`GetFullPath` is not equivalent to `pwd -P`.** One is a string operation,
  the other touches the filesystem. `GetFullPath` collapses `..` but never
  follows reparse points, so a **directory junction** inside the project root
  pointing outside it passed containment and would have handed an agent a
  working directory outside the project. PowerShell 5.1 has no
  `ResolveLinkTarget`, so `dispatch.ps1` now **refuses to traverse** a reparse
  point — candidate *and every ancestor*, because `repo: link/inner` hides the
  junction above the leaf.
  **The dispatchers now differ on purpose:** POSIX resolves a link and accepts
  one staying inside the project; Windows refuses either way. Documented in
  `backlog/prompts/README.md`.
- **The loose fallback lookup could select a neighbouring task.** `BACK-1`
  matched `BACK-12`'s file given a filename the anchored pattern misses. Both
  dispatchers now confirm the file's `id:` before trusting its `repo:`.

## What is left

1. **Merge #10.** It does not turn CI green and is not meant to — it makes CI
   *informative*. Seven pre-existing failures remain on Ubuntu; locally on macOS
   the set is **10**, and the three extras are all editor-related
   (`editTaskInTui` ×2, `openInEditor`), so those look macOS-specific while the
   other seven reproduce on both. Logan is investigating those separately.
2. **Consider `fail-fast: false`** on the CI matrix. Until the seven are fixed,
   macOS and Windows results stay invisible.
3. **The orange header — the open design decision.** Three theme variants exist
   and the palette work has gone about as far as it can. What actually makes
   bankaya.com.mx recognisable is a **solid orange header bar**, and a theme
   cannot produce it: the header and sidebar are painted with `bg-gray-100` /
   `dark:bg-gray-800`, the *same tokens* as cards, chips and hover states, so
   overriding them colours everything. Needs a component change (~20 lines in
   `Layout`/`SideNavigation`). **Undecided: top bar only, or top bar + sidebar.**
   The second is a lot of chrome competing with the cards on a tool you stare at
   all day.
4. **`dispatch.sh` ignores the role-scoped MCP configs.** Only `dispatch.ps1`
   passes `--strict-mcp-config --mcp-config .claude/mcp-{coder,reviewer}.json`.
   On POSIX, dispatched agents use the ambient user-scope config, so coder and
   reviewer get the same servers. `.claude/mcp-coder.json` also references
   `npx.cmd`, which is Windows-only.
5. **The opt-in `Testing` runner** is still invoked with the project root, not
   the task's repo.
6. **Per-repo merge requests.** `create-mr.ps1` takes a single
   `GITLAB_PROJECT_ID`; Bankaya is on **Bitbucket**. Either the reviewer agent
   opens PRs via MCP, or a per-repo variant is needed.

## Environment facts that cost time this session

- **The hub lives at `~/code`**, outside this repo, created with
  `backlog init --no-git` (filesystem-only). Prefix `bnk`, full agent-loop
  statuses, `shell: auto`, POSIX dispatcher. The five service repos and this
  repo are siblings under it. `~/code/Backlog.md` keeps its own backlog —
  verified that root resolution picks the nearest, so the two do not collide.
- **Theme files are in `~/code/backlog/themes/`, deliberately not in this repo**
  — brand hexes plus the company name do not belong in a public fork. Three
  variants: `bankaya` (navy neutrals, dark-first), `bankaya-warm` (warm charcoal
  surfaces — the one that finally read as orange), `bankaya-light` (cool
  neutrals, light-first, currently active).
- **The grey ramp does two unrelated jobs**, and missing this is what made the
  first theme look blue: in light mode its dark steps are *text*
  (`text-gray-900` ×157), in dark mode the same steps are *surfaces*
  (`dark:bg-gray-800` ×113). Brand navy is right for the first and drowns the
  second. Hence the separate `.dark` block. Warm greys read as *dirty* against
  white, so light mode wants the cool axis and dark mode the warm one.
- **`install:local` produces a binary macOS kills on sight** (`Killed: 9`):
  copying over the existing file invalidates its ad-hoc signature. Fixed in #10
  (`rm` before `cp`, re-sign, fail loudly). Until that merges, install by hand.
- **`backlog` is on PATH via `~/.local/bin/backlog` → `~/.bun/bin/backlog`.**
  `~/.bun/bin` is not on PATH on this machine; the symlink is what makes
  `install:local` reach it.
- **git remote is HTTPS**, not SSH: the ed25519 key is not on the GitHub
  account, and `gh auth login` was done with the HTTPS protocol. `gh` is
  installed. Bitbucket uses a separate key and is unaffected.
- **`Bankaya_2022_short brandbook.pdf` sits in this repo's working tree** and is
  excluded only via `.git/info/exclude` (local, not committed). The remote is a
  **public** fork, so one `git add -A` would publish it. It should be moved out
  of the repo; an exclude protects this clone only.
- The brandbook palette, for reference: Naranja `#FE411A`, Rosa `#FB2048`,
  Azul `#2364E6`, White Pearl `#F0F2F9`, Black blue `#101239`. Azul converts to
  almost exactly Tailwind's `blue-600`, so the stock UI was already on-brand for
  blue.

---

# Session of 2026-09-02/04 — live agent panel work

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

### 7. Fenced tasks read as `hop 7/6`

**The panel has now been reviewed in a browser by a person** (2026-09-07, on the
kiero-app board) and the layout is confirmed. That review found one thing.

`dispatch.ps1` claims one hop file *beyond* the cap as a sentinel and then
refuses — the loop runs to `$maxRoundTrips + 1`, and `$trips -gt $maxRoundTrips`
exits without dispatching. So `.hop-007` records **that the fence fired**, not
that a seventh hop ran. `hopCount()` reported 7 faithfully and the pane rendered
`hop {hop}/{maxHops}` — `hop 7/6` on screen, for the one state that cannot
proceed without a human.

Worse, it was styled identically to `hop 6/6`, which is a different state:
6/6 means *the next hop is blocked*, 7 means *a dispatch has already been
refused*. `LiveAgentPanel.tsx` now clamps the number, adds `· fenced` in red, and
puts the reset in the tooltip — nothing else told you that a fenced task stays
fenced until `backlog/prompts/logs/<id>.hop-*` is deleted by hand.

The clamp is deliberately in the view. `hop` stays the raw claimed count over the
API, because the sentinel is real bookkeeping and the +1 is the dispatcher's
contract to describe, not the server's to launder.

### 8. `Blocked`, and what happens when the fence fires

The guard stopped the loop but left the task where it stopped. A fenced task sat
in `In Progress` or `In Review` looking exactly like a healthy one, and the only
trace was a line in a log nobody reads — so it stopped moving and nobody found
out until someone wondered why. `hop 6/6` in the panel was the only tell, and the
panel is not where you look when you are not already suspicious.

`Blocked` is now a real column. The fence appends the reason to the task's notes
and moves it there. One definition covers both it and the manual use (infra down,
waiting on another task, a decision nobody has made): **no further automated
progress is possible until a person acts.**

**Leaving `Blocked` clears the hop claims, and that is the feature.** The column
on its own would have been cosmetic — the same stuck task on a better shelf.
Dragging a task out is the only signal in the system that a person has looked at
a fenced task and vouched for it, so that is where the counter resets. Without
it the task re-fences on its first dispatch and `Blocked` is a column tasks enter
and never leave. It also retires the hand-run `rm ... .hop-*` that §7 above had
just put in a tooltip.

**What deliberately does NOT go there: the transient failures.** Provider session
limits, a crashed MCP subprocess, a machine hiccup. Both panes in the screenshot
that prompted this were sitting on `You've hit your session limit — resets
1:20am`, which is not a blocked task but a paused one, and moving those would
have made things worse twice over: `watchdog.ps1` finds resumable agents *by the
status they were dispatched for*, and so does `isLikelyRunning()` (§2). Parking
them in `Blocked` hides them from the one thing that recovers them and drops
their pane from the panel — converting a self-healing case into a manual one to
make it look tidier.

The watchdog skips `Blocked` by an explicit `$neverResumeStatuses` rule rather
than by being absent from `$watchedStatuses`. The two lists answer different
questions — "has a process that can die" versus "must never be auto-resumed" —
and widening the first must not silently widen the second.

**Two things nearly went wrong, both worth remembering:**

- **`Blocked` must not be last in `statuses`.** `getTerminalStatus()` is defined
  as the final entry, and that is what `getTerminalStatusTasksByAge()` archives by
  age and what the board's cleanup affordance hangs off. Appending it after `Done`
  — the obvious placement, since it is an exit from the flow — points cleanup at
  blocked tasks and stops it ever archiving finished ones. It sits second-to-last;
  `src/test/agent-loop-statuses.test.ts` pins that, because nothing else would
  catch a reorder.
- **`task edit --notes` REPLACES the notes section.** The reason a task is being
  fenced is the six rounds recorded in its notes, so writing the block reason with
  `--notes` would delete exactly the evidence the human needs. `--append-notes`.

Both dispatchers also learned that `$logDir`/`$safeTaskId` (and the sh
equivalents) are needed *before* prompt selection now, since the unblock reset
runs there; they were previously set below it.

Unlike `Testing` (§5), this ships in the default statuses. The reasoning inverts:
`Testing` strands every task entering it without a runner, whereas `Blocked` needs
nothing behind it — nothing dispatches on it by design.

**Not verified against a live loop.** The paths are exercised only by reading:
no task has actually been fenced since the change. The first real fence is worth
watching, particularly that the in-hook `backlog task edit -s Blocked` re-enters
the dispatcher and exits cleanly rather than doing anything surprising.

---

## Environment facts that cost time

- **The dev server bundles at startup.** A browser reload alone never shows a code
  change — restart the server. To update the global binary:
  `bun run build && bun run install:local`, then restart. Running straight from
  source always reflects the checkout:
  `bun run <fork>/src/cli.ts browser --port 6499 --no-open`.
- **`bun test` needs Git ≥ 2.28 AND a `safe.directory` entry for `tmp/`.** With
  both in place the suite is *mostly green*: **1403 pass / 42 fail / 6 skip** across
  1451 tests (measured 2026-09-09, Git 2.55.0.windows.5). Without them it is not,
  and the two failure modes look nothing alike:

  | state | result | error |
  |---|---|---|
  | Git 2.27 | 410 fail | ``git init -b main`` → ``unknown switch `b'`` |
  | Git 2.55, no safe.directory | **508 fail** | `fatal: detected dubious ownership` |
  | Git 2.55 + `tmp/*` entry | **42 fail** | assorted, see below |

  `git init -b` arrived in Git **2.28**; every suite opens with it (47 of 170 files,
  76 calls), so an older Git fails them all in `beforeEach`. Git Bash and Git for
  Windows are one package — upgrading either upgrades both.

  Upgrading alone makes things *worse*, which is the trap. **This repo lives on
  `D:`, which is exFAT**, a filesystem that records no ownership. Git ≥ **2.35.2**
  refuses repos it cannot prove ownership of, so every fixture repo under
  `<repo>/tmp/` is rejected — surfacing confusingly as `fatal: not in a git
  directory` from the following `git config`, because git had already declined to
  see a repo there. The main checkout is rejected too: `git status` in this repo
  stops working the moment you upgrade.

  Two entries are needed, and a trailing `/*` **is** honoured (verified), so the
  ownership check stays on everywhere else:

  ```
  git config --global --add safe.directory D:/1064n/Programacion/claude/Backlog.md
  git config --global --add safe.directory "D:/1064n/Programacion/claude/Backlog.md/tmp/*"
  ```

  Judge a change by **diffing failing test names** against this 42, not by the count.

- **The remaining 42 are not yet triaged**, but they cluster. Roughly 14 are
  git-commit related — `Auto-commit configuration`, `CLI Auto-Commit Behavior`,
  `MCP milestone tools`, `CLI Integration > git integration` — and they fail on
  `isClean()` returning false *after* the commit count assertion passed, i.e. the
  commit happens and something is left dirty behind it. Not exFAT: a
  git-init/write/commit/status cycle was compared on exFAT and NTFS and both came
  back clean, so suspect the app's own staging logic. Another 9 are timeouts, and
  the rest are assorted (`editTaskInTui`, `CLI Priority Filtering`, the known
  `dispatch.ps1` stdin test).

- **The suite writes into the project's own `backlog/` directory** — it does not
  confine itself to temp fixtures. Seen so far: it modifies
  `src/web/styles/style.css`, creates `backlog/docs/doc-4 - No-Git-Doc.md`, and
  **promotes `backlog/drafts/draft-1` into `backlog/tasks/back-466`** (a real
  draft in this repo, deleted and rewritten as a task). The exact set varies by
  run. Check `git status` after every `bun test` and revert what you did not
  intend — it is enough to break `git stash pop` mid-work, and the draft
  promotion is easy to mistake for real work and commit by accident.
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

1. **`dispatch.sh` has no stranded-retry path.** Safe (it launches fresh) but a
   real feature gap versus `dispatch.ps1`. Left rather than written blind, since a
   resume path cannot be exercised without live agents.
2. **The ~16 non-Git test failures.** Small once Git ≥ 2.28 is installed (see
   above), and worth a look then: the auto-commit `isClean()` trio may be real,
   the ~5000 ms timeouts are probably fixture latency rather than bugs.

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
