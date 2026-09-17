#!/usr/bin/env bash
# Backlog.md status-change dispatcher (POSIX shell)
#
# Set in backlog.config.yml:
#   shell: "sh"               # or "bash" / "auto"
#   onStatusChange: '"$PWD/backlog/prompts/dispatch.sh"'
#
# Env vars injected by Backlog.md: TASK_ID, OLD_STATUS, NEW_STATUS, TASK_TITLE.
# Picks the prompt file matching $NEW_STATUS, reads the per-task agent/reviewAgent
# field from the task frontmatter, and launches the right CLI in the background.

set -eu

# `pipefail` is not POSIX. dash only gained it in 0.5.12, and an older dash --
# which is what /bin/sh is on some Debian and Ubuntu images -- answers
# "Illegal option -o pipefail" and exits 2 before doing anything at all, which
# is the whole dispatch loop dead with a message nobody reads. Ask for it in a
# subshell first and carry on without it where it is missing: every pipeline
# whose failure would matter here is already guarded with `|| true`, so its
# absence changes no behaviour.
if (set -o pipefail) 2>/dev/null; then
    set -o pipefail
fi

# $0, not ${BASH_SOURCE[0]}: the array subscript is a bashism, and this script
# is invoked as `sh dispatch.sh` by the hook. Under dash -- which IS /bin/sh on
# Debian and Ubuntu -- the old form raised "Bad substitution", left script_dir
# empty, pointed project_root somewhere else entirely, and the dispatcher then
# exited 0 having silently done nothing. The script is executed, never sourced,
# so $0 is the right answer anyway.
script_dir="$(cd "$(dirname "$0")" && pwd)"
prompts_dir="$script_dir"
project_root="$(cd "$script_dir/../.." && pwd)"

# ── Atomic file claim ─────────────────────────────────────────────────────────
# The Windows dispatcher gets this from File::Open with CreateNew. The POSIX
# equivalent is `set -C` (noclobber), under which `> file` fails if the file
# already exists — the check and the create happen in one syscall (O_EXCL), so
# exactly one racing process can ever win. A plain `[ -f ] && ...` test would be
# a TOCTOU race and defeat the entire point of these guards.
claim_file() {
    if (set -C; : > "$1") 2>/dev/null; then
        return 0
    fi
    return 1
}

# Set BACKLOG_DISPATCH_MODE=test in the env that launches Backlog.md to pick
# the smoke-test prompts (no-op agents that just wait and transition to the
# next status). Anything else uses the real prompts.
if [ "${BACKLOG_DISPATCH_MODE:-}" = "test" ]; then
    suffix=".test.md"
else
    suffix=".md"
fi

# ── Testing status: hand off to the project's own test runner ─────────────────
# OPT-IN, and not part of the default pipeline: a `Testing` column with no runner
# behind it strands every task that enters it. To use it, add "Testing" to
# `statuses:` in backlog/config.yml between In Progress and In Review, drop a
# `run-full-suite.sh` next to this file, and have your coder prompt move finished
# work to `Testing` instead of straight to `In Review`.
#
# The runner is project-specific — it knows how your suite boots — so none ships
# here. Its contract: invoked as `run-full-suite.sh <taskId> <projectRoot>`, runs
# detached for as long as it needs, and reports back through the backlog CLI
# (all green -> In Review; any red -> In Progress with the failure in the notes).
# A red result landing back in In Progress is picked up as a coder rework below.
if [ "${NEW_STATUS:-}" = "Testing" ]; then
    test_log_dir="$prompts_dir/logs"
    mkdir -p "$test_log_dir"
    test_runner="$prompts_dir/run-full-suite.sh"
    safe_test_task_id="$(printf '%s' "${TASK_ID:-unknown}" | tr -c 'A-Za-z0-9._-' '_')"

    if [ ! -f "$test_runner" ]; then
        # Say so loudly: silence here looks exactly like a passing gate, and the
        # task would sit in Testing forever with nobody able to tell why.
        echo "dispatch.sh: task ${TASK_ID:-?} entered 'Testing' but no run-full-suite.sh exists next to this script." >&2
        echo "dispatch.sh: it will sit there until a human moves it. Add a runner, or drop 'Testing' from statuses in backlog/config.yml." >&2
        exit 0
    fi

    test_lock="$test_log_dir/$safe_test_task_id-Testing.dedup"
    if [ -f "$test_lock" ]; then
        test_lock_mtime="$(date -r "$test_lock" +%s 2>/dev/null || echo 0)"
        if [ "$test_lock_mtime" -gt 0 ] && [ $(( $(date +%s) - test_lock_mtime )) -gt 90 ]; then
            rm -f "$test_lock" 2>/dev/null || true
        fi
    fi
    if ! claim_file "$test_lock"; then
        echo "dispatch.sh: duplicate Testing dispatch suppressed for ${TASK_ID:-?} (within 90s dedup window)"
        exit 0
    fi

    test_stamp="$(date +%Y%m%d-%H%M%S-%3N)"
    test_log="$test_log_dir/$test_stamp-$$-$safe_test_task_id-Testing.log"
    echo "dispatch.sh: task=${TASK_ID:-?} status=Testing -- launching run-full-suite.sh detached"
    (
        cd "$project_root"
        nohup sh "$test_runner" "${TASK_ID:-}" "$project_root" > "$test_log" 2> "$test_log.err" &
    ) >/dev/null 2>&1
    exit 0
fi

# ── Per-task log paths ───────────────────────────────────────────────────
# Set here rather than with the rest of the log setup further down, because the
# Blocked branch below needs them and runs before any of that.
log_dir="$prompts_dir/logs"
mkdir -p "$log_dir"
sanitize() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }
safe_task_id="$(sanitize "${TASK_ID:-unknown}")"

# ── Blocked ──────────────────────────────────────────────────────────────────
# Where the loop guard parks a task it has fenced, and where a human parks one
# that cannot proceed for any other reason (infra down, waiting on another task,
# a decision nobody has made yet). Definition: NO FURTHER AUTOMATED PROGRESS IS
# POSSIBLE UNTIL A PERSON ACTS.
#
# That deliberately excludes transient failures -- provider session limits, a
# crashed MCP subprocess, a machine hiccup. Those resolve themselves or are
# resumed by the watchdog, which finds them by the status they were dispatched
# for; moving them here would hide them from the one thing that recovers them.
#
# Nothing dispatches on Blocked: the case below falls through to `exit 0`.
#
# LEAVING it is the interesting half. A human dragging a task out of Blocked is
# the only signal that someone has looked at a fenced task and vouched for it, so
# that is where the hop claims get cleared. Without this the task re-fences on
# its first dispatch and the column becomes one tasks enter and never leave.
if [ "${OLD_STATUS:-}" = "Blocked" ] && [ "${NEW_STATUS:-}" != "Blocked" ]; then
    cleared="$(find "$log_dir" -maxdepth 1 -name "$safe_task_id.hop-*" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${cleared:-0}" -gt 0 ]; then
        find "$log_dir" -maxdepth 1 -name "$safe_task_id.hop-*" -delete 2>/dev/null || true
        echo "dispatch.sh: unblocked ${TASK_ID:-?} - cleared $cleared hop claim(s); the loop guard starts over."
    fi
fi

case "${NEW_STATUS:-}" in
    "In Progress")  prompt_file="$prompts_dir/code$suffix" ;;
    "In Review")    prompt_file="$prompts_dir/review$suffix" ;;
    "Human Review") prompt_file="$prompts_dir/ready$suffix" ;;
    *) exit 0 ;;  # Status change we don't dispatch on
esac

if [ ! -f "$prompt_file" ]; then
    echo "dispatch.sh: prompt file not found: $prompt_file" >&2
    exit 0
fi

# ── Task file lookup ─────────────────────────────────────────────────────────
# Resolved once, here, and reused by both the repo resolution below and the
# agent/session-id resolution further down.
#
# Matched with an anchored, case-insensitive pattern rather than a bare
# substring: task ids arrive uppercase (BACK-12) while filenames are lowercase
# (`back-12 - Title.md`), which only matches at all on a case-insensitive
# filesystem, and an unanchored `*BACK-4*` also matches `back-46` and
# `back-466`. Either way you get the wrong task's frontmatter — tolerable when
# it only picked an agent name, not when it decides which repository an agent
# with skipped permissions is turned loose in. The loose glob stays as a
# fallback so no existing project's naming stops resolving.
#
# The `|| true` on each substitution is load-bearing: this script runs under
# `set -euo pipefail`, so a pipeline whose first stage exits non-zero (a find
# that matches nothing) would otherwise abort the whole dispatch.
task_file="$(find "$project_root/backlog/tasks" -maxdepth 1 -iname "${TASK_ID:-} - *.md" 2>/dev/null | head -1 || true)"
if [ -z "$task_file" ]; then
    task_file="$(find "$project_root/backlog/tasks" -name "*${TASK_ID:-}*" 2>/dev/null | head -1 || true)"
fi

# Confirm the file actually is this task before anything trusts its `repo:`.
#
# The fallback above is a substring match, so BACK-1 can still select BACK-12's
# file when a project uses a filename the anchored pattern does not fit. The id
# in the frontmatter is the authority, and it is free to check because the file
# is read either way. A file carrying no `id:` at all is left alone rather than
# rejected, so an unusual-but-valid project keeps dispatching.
if [ -n "$task_file" ] && [ -f "$task_file" ]; then
    found_id="$(grep -m1 '^id:' "$task_file" 2>/dev/null | sed "s/^id:[[:space:]]*//" | sed "s/[[:space:]]*$//" | tr -d "'\"" || true)"
    if [ -n "$found_id" ] &&
       [ "$(printf '%s' "$found_id" | tr 'A-Z' 'a-z')" != "$(printf '%s' "${TASK_ID:-}" | tr 'A-Z' 'a-z')" ]; then
        echo "dispatch.sh: ignoring $task_file - its id ($found_id) is not ${TASK_ID:-?}."
        task_file=""
    fi
fi

# ── Target repository resolution ─────────────────────────────────────────────
# A task may name the repository it targets (frontmatter `repo:`), so a single
# hub backlog can drive work across sibling repositories. The value is a path
# relative to the project root.
#
# No `repo:` is the normal, single-repo case: the agent runs at the project
# root exactly as it always has, and everything below is skipped.
#
# This block is deliberately side-effect free so it can run before the dry-run
# gate, and before the dedup and hop guards — a misconfigured repo must not
# burn a hop claim, which counts coder/reviewer disagreement, not typos.
task_repo=""
if [ -n "$task_file" ] && [ -f "$task_file" ]; then
    # `|| true`: no `repo:` line is the common case, and a non-matching grep
    # under `set -o pipefail` would abort the dispatch.
    task_repo="$(grep -m1 '^repo:' "$task_file" 2>/dev/null | sed "s/^repo:[[:space:]]*//" | sed "s/[[:space:]]*$//" | tr -d "'\"" || true)"
fi

agent_workdir="$project_root"
repo_error=""
if [ -n "$task_repo" ]; then
    case "$task_repo" in
        /*|~*) repo_error="absolute paths are not allowed; use a path relative to the project root" ;;
    esac

    if [ -z "$repo_error" ]; then
        # cd + `pwd -P` resolves "..", symlinks and any other trickery in one
        # step; the containment check below then sees the real destination
        # rather than the string that was written down.
        resolved_repo="$(cd "$project_root/$task_repo" 2>/dev/null && pwd -P || true)"
        project_root_real="$(cd "$project_root" 2>/dev/null && pwd -P || true)"
        if [ -z "$resolved_repo" ]; then
            repo_error="no such directory: $project_root/$task_repo"
        else
            case "$resolved_repo" in
                "$project_root_real"/*) ;;
                # An agent launches with permissions skipped, so a task must
                # never be able to point one at somewhere outside the project.
                *) repo_error="resolves outside the project root ($resolved_repo)" ;;
            esac
        fi
        # `.git` is a file, not a directory, in worktrees and submodules.
        if [ -z "$repo_error" ] && [ ! -e "$resolved_repo/.git" ]; then
            repo_error="not a git repository (no .git in $resolved_repo)"
        fi
        # A plain `[ ... ] && ...` here would be the last command in the block
        # and, when false, would abort the script under `set -e`.
        if [ -z "$repo_error" ]; then
            agent_workdir="$resolved_repo"
        fi
    fi
fi

if [ -n "$repo_error" ]; then
    echo "dispatch.sh: ${TASK_ID:-?} has repo '$task_repo' which cannot be used: $repo_error"
else
    echo "dispatch.sh: workdir=$agent_workdir${task_repo:+ (repo: $task_repo)}"
fi

# Build the full prompt: template body + task context.
#
# The repository line is only appended when the task names one. A single-repo
# project gets exactly the context block it always got, byte for byte.
repo_context=""
if [ -n "$task_repo" ] && [ -z "$repo_error" ]; then
    repo_context="
Repository: $task_repo (you are already running inside it: $agent_workdir)"
fi

full_prompt="$(cat "$prompt_file")

---
Task: ${TASK_ID:-?} — ${TASK_TITLE:-?}
Status: ${OLD_STATUS:-?} → ${NEW_STATUS:-?}$repo_context"

# Per-invocation log file so concurrent hooks don't clobber each other.
# log_dir, sanitize() and safe_task_id are set above, before the Blocked branch.
timestamp="$(date +%Y%m%d-%H%M%S-%3N)"
safe_status="$(sanitize "${NEW_STATUS:-unknown}")"
log_file="$log_dir/$timestamp-$$-$safe_task_id-$safe_status.log"
prompt_path="$log_file.prompt"
printf '%s' "$full_prompt" > "$prompt_path"

# Dry-run mode: do everything except spawn the agent. Sits after repo
# resolution (which is side-effect free) so the resolved working directory and
# any rejection reason are both observable without launching anything or
# touching task state.
if [ "${BACKLOG_DISPATCH_DRY_RUN:-}" = "1" ]; then
    exit 0
fi

# ── Unusable repo: park the task instead of dispatching ──────────────────────
# Same treatment the loop guard gives a fenced task, and for the same reason:
# refusing to dispatch while leaving the task where it was makes it look
# healthy on the board, and the only trace is a log line nobody reads. A task
# pointing at a repo that does not exist needs a person, so it goes in front of
# one.
#
# --append-notes, never --notes: the latter replaces the whole notes section.
if [ -n "$repo_error" ]; then
    repo_note="Dispatch blocked: the task targets repo '$task_repo', which cannot be used.
Reason: $repo_error
Transition: ${OLD_STATUS:-?} -> ${NEW_STATUS:-?}. Log: $log_file

Set a valid repo (a path relative to the project root, e.g. payments-api), or
clear the field to run at the project root, then move this task out of Blocked."

    if (cd "$project_root" && backlog task edit "${TASK_ID:-}" --append-notes "$repo_note" >/dev/null 2>&1); then
        :
    else
        echo "dispatch.sh: could not append the repo failure to ${TASK_ID:-?}."
    fi
    if (cd "$project_root" && backlog task edit "${TASK_ID:-}" -s Blocked >/dev/null 2>&1); then
        echo "dispatch.sh: ${TASK_ID:-?} moved to Blocked - unusable repo."
    else
        echo "dispatch.sh: ${TASK_ID:-?} stays in ${NEW_STATUS:-?} - no Blocked status configured, or the CLI is unavailable."
    fi
    exit 0
fi

# ── Deduplication guard ───────────────────────────────────────────────────────
# The onStatusChange hook can fire more than once for the same event when the
# in-process dispatch and the file-watcher dispatch race.
#
# The key is (taskId, status) ONLY — deliberately no timestamp. An earlier
# Windows version embedded the current second, so two dispatches a few seconds
# apart hashed to different keys and both launched, attaching two agents to one
# worktree and producing two parallel implementations of the same feature.
# Staleness is decided by the lock file's AGE instead.
dedupe_ttl_seconds=90
dedupe_lock="$log_dir/$safe_task_id-$safe_status.dedup"

# Clear a lock older than the TTL so a legitimate later re-dispatch (rework, a
# relaunch of a stranded session) is never blocked forever. Failure to clear one
# must never be fatal, hence the redirected errors throughout.
if [ -f "$dedupe_lock" ]; then
    lock_mtime="$(date -r "$dedupe_lock" +%s 2>/dev/null || echo 0)"
    now_epoch="$(date +%s)"
    if [ "$lock_mtime" -gt 0 ] && [ $((now_epoch - lock_mtime)) -gt "$dedupe_ttl_seconds" ]; then
        rm -f "$dedupe_lock" 2>/dev/null || true
    fi
fi

if ! claim_file "$dedupe_lock"; then
    echo "dispatch.sh: duplicate suppressed for ${TASK_ID:-?} -> ${NEW_STATUS:-?} (within ${dedupe_ttl_seconds}s dedup window)"
    exit 0
fi

# ── Ping-pong loop guard ──────────────────────────────────────────────────────
# The dedup lock only stops SIMULTANEOUS dispatches. It does nothing about a task
# bouncing coder -> In Review -> reviewer -> In Progress -> coder forever, each
# hop a legitimate, well-spaced dispatch. One task did exactly that and burned
# two 5-hour provider usage windows before a human noticed — neither agent
# misbehaving, nothing counting.
#
# Each dispatch CLAIMS a hop number by atomically creating "<task>.hop-NNN"; the
# claimed number IS the count. A read-increment-write counter would be a
# lost-update race, and this hook has been observed firing 17 times for a single
# status change when several Backlog.md processes each ran it.
max_round_trips=6
# A crash-recovery restart is NOT a round trip: watchdog.ps1 re-fires a dead
# agent with OLD_STATUS = NEW_STATUS, a signature no real transition produces.
# This guard exists to stop coder/reviewer DISAGREEMENT, so it counts
# disagreement, not crashes.
if [ "${OLD_STATUS:-}" != "${NEW_STATUS:-}" ] &&
   { [ "${NEW_STATUS:-}" = "In Progress" ] || [ "${NEW_STATUS:-}" = "In Review" ]; }; then
    # Age out a finished/abandoned cycle so a task is never blocked forever.
    find "$log_dir" -maxdepth 1 -name "$safe_task_id.hop-*" -mmin +1440 -delete 2>/dev/null || true

    trips=0
    n=1
    while [ "$n" -le $((max_round_trips + 1)) ]; do
        hop_file="$(printf '%s/%s.hop-%03d' "$log_dir" "$safe_task_id" "$n")"
        if claim_file "$hop_file"; then
            trips="$n"
            break
        fi
        n=$((n + 1))
    done

    if [ "$trips" -eq 0 ] || [ "$trips" -gt "$max_round_trips" ]; then
        echo "dispatch.sh: LOOP GUARD - ${TASK_ID:-?} has exhausted $max_round_trips coder/reviewer hops. NOT dispatching."

        # Park it in Blocked rather than leaving it where it stopped. Refusing to
        # dispatch used to be the whole guard, which left the task sitting in
        # In Progress/In Review looking exactly like a healthy one -- the only
        # trace was a line in a log nobody reads. Moving it puts it on the board,
        # in front of the person who has to decide.
        #
        # Safe from inside the hook: this status change re-enters dispatch.sh and
        # Blocked falls through the case above to exit 0. The note goes in first
        # and without -s, so the reason is on the task before the move lands.
        #
        # --append-notes, never --notes: the latter REPLACES the notes section,
        # deleting the coder's and reviewer's record of the six rounds that are
        # the whole reason this is being fenced.
        blocked_note="Loop guard: fenced after $max_round_trips coder/reviewer hops without converging.
Last transition: ${OLD_STATUS:-?} -> ${NEW_STATUS:-?}. Log: $log_file

The agents were not misbehaving -- they simply kept disagreeing. A human needs to
re-scope, split, reassign, or accept it. Moving this task out of Blocked clears
the hop claims and the loop starts over."

        # Run from the project root: the CLI locates the project by walking up
        # from the working directory, and the hook inherits whatever cwd the
        # server that fired it happened to have. Subshell so the cd cannot leak.
        if (cd "$project_root" && backlog task edit "${TASK_ID:-}" --append-notes "$blocked_note" >/dev/null 2>&1); then
            :
        else
            echo "dispatch.sh: could not append the block reason to ${TASK_ID:-?}."
        fi
        if (cd "$project_root" && backlog task edit "${TASK_ID:-}" -s Blocked >/dev/null 2>&1); then
            echo "dispatch.sh: ${TASK_ID:-?} moved to Blocked for a human decision."
        else
            # A project whose statuses have no Blocked (or no CLI on PATH) keeps
            # the old behaviour: fenced in place, nothing dispatched.
            echo "dispatch.sh: ${TASK_ID:-?} stays in ${NEW_STATUS:-?} - no Blocked status configured, or the CLI is unavailable."
            echo "dispatch.sh: a human must decide (re-scope, reassign, or split). Reset with: rm '$log_dir/$safe_task_id.hop-'*"
        fi
        exit 0
    fi
    if [ "$trips" -eq "$max_round_trips" ]; then
        echo "dispatch.sh: WARNING - ${TASK_ID:-?} is on hop $trips of $max_round_trips; the next one is blocked."
    fi
fi

# Prune dedup files well past the TTL so they don't accumulate.
find "$log_dir" -maxdepth 1 -name '*.dedup' -mmin +6 -delete 2>/dev/null || true

# ── Dispatch-log retention ────────────────────────────────────────────────────
# Nothing used to prune these, and one deployment's log directory reached 48,967
# files / 727 MB — a retry storm wrote 29,720 files in a single day. Keep 14
# days: far longer than any post-mortem needs, still bounded. Never fatal.
for ext in log err pid prompt rework resume; do
    find "$log_dir" -maxdepth 1 -type f -name "*.$ext" -mtime +14 -delete 2>/dev/null || true
done
# Hop claims have no fixed suffix (.hop-001, .hop-002, ...) so they need their own
# glob. Safe at 14 days: the loop guard ages out anything over 24h before it
# claims, so a fortnight-old claim can no longer affect a dispatch. Without this
# nothing ever removed them and a task that stops dispatching keeps them forever.
find "$log_dir" -maxdepth 1 -type f -name '*.hop-*' -mtime +14 -delete 2>/dev/null || true

# ── Agent resolution ─────────────────────────────────────────────────────────
#
# Priority: per-task frontmatter field > BACKLOG_DEFAULT_AGENT env var > "claude"
#
# For "In Review", prefers reviewAgent: from the task, falls back to agent:,
# then to the default. This lets coder and reviewer be different agents per task
# without touching dispatcher code.
#
task_agent=""
task_review_agent=""
coder_session_id=""
# task_file was resolved once, up with the repo resolution.
if [ -n "$task_file" ] && [ -f "$task_file" ]; then
    # Every one of these greps legitimately finds nothing on some task: a human
    # task has no `agent:`, most tasks have no `reviewAgent:`, and a first
    # dispatch has no session id yet. Under `set -o pipefail` a non-matching
    # grep makes the whole substitution non-zero and `set -e` then aborted the
    # dispatch — so a human task exited 1 here instead of reaching the "not an
    # agent task" check ten lines below, and every such transition was reported
    # as a failed status-change callback. Hence `|| true` on each.
    task_agent="$(grep -m1 '^agent:' "$task_file" 2>/dev/null | sed "s/^agent:[[:space:]]*//" | sed "s/[[:space:]]*$//" | tr -d "'\"" || true)"
    task_review_agent="$(grep -m1 '^reviewAgent:' "$task_file" 2>/dev/null | sed "s/^reviewAgent:[[:space:]]*//" | sed "s/[[:space:]]*$//" | tr -d "'\"" || true)"
    # Extract the last "Session ID: <uuid>" from the task body for --resume on rework.
    # Match both UUID (claude/codex) and ses_* (opencode) session ID formats.
    coder_session_id="$(grep -oE 'Session ID: ([a-f0-9-]{36}|ses_[A-Za-z0-9]+)' "$task_file" 2>/dev/null | tail -1 | sed 's/Session ID: //' || true)"
    reviewer_session_id="$(grep -oE 'Reviewer Session ID: ([a-f0-9-]{36}|ses_[A-Za-z0-9]+)' "$task_file" 2>/dev/null | tail -1 | sed 's/Reviewer Session ID: //' || true)"
fi

# Tasks without an `agent:` field are human tasks — do not dispatch an
# agent for them. The only exception is "Human Review" which fires the
# ready.md notifier regardless (it just logs a summary, not implementation
# work). The notifier uses whatever agent IS on the task, or falls back
# to claude as a lightweight runner.
if [ -z "$task_agent" ] && [ "${NEW_STATUS:-}" != "Human Review" ]; then
    exit 0
fi

case "${NEW_STATUS:-}" in
    "In Review")
        # Prefer the dedicated reviewer agent; fall back to the coder agent.
        if [ -n "$task_review_agent" ]; then
            agent_name="$task_review_agent"
        else
            agent_name="$task_agent"
        fi
        ;;
    "Human Review")
        # Notifier: use coder agent if set, otherwise claude.
        agent_name="${task_agent:-claude}"
        ;;
    *)
        agent_name="$task_agent"
        ;;
esac

# ── Alias → binary resolution ─────────────────────────────────────────────────
config_file="$project_root/backlog/config.yml"
agent_binary="$agent_name"
agent_model=""
agent_effort=""
if [ -f "$config_file" ]; then
    in_agents=0
    current_alias=""
    # `alias:` opens an entry; binary/model/effort attach to the current alias
    # (model/effort follow binary in the YAML, so keep the alias as context
    # until the next entry rather than clearing it on binary).
    while IFS= read -r line || [ -n "$line" ]; do
        if echo "$line" | grep -q '^agents:'; then
            in_agents=1; continue
        fi
        if [ "$in_agents" = "1" ]; then
            if echo "$line" | grep -qE '^[A-Za-z_]'; then
                in_agents=0; continue
            fi
            if echo "$line" | grep -qE '^\s+-\s+alias:'; then
                current_alias="$(echo "$line" | sed "s/.*alias:[[:space:]]*//" | tr -d "'\" ")"
            elif [ -n "$current_alias" ] && echo "$line" | grep -qE '^\s+binary:'; then
                if [ "$current_alias" = "$agent_name" ]; then
                    agent_binary="$(echo "$line" | sed "s/.*binary:[[:space:]]*//" | tr -d "'\" ")"
                fi
            elif [ -n "$current_alias" ] && echo "$line" | grep -qE '^\s+model:'; then
                if [ "$current_alias" = "$agent_name" ]; then
                    agent_model="$(echo "$line" | sed "s/.*model:[[:space:]]*//" | tr -d "'\" ")"
                fi
            elif [ -n "$current_alias" ] && echo "$line" | grep -qE '^\s+effort:'; then
                if [ "$current_alias" = "$agent_name" ]; then
                    agent_effort="$(echo "$line" | sed "s/.*effort:[[:space:]]*//" | tr -d "'\" ")"
                fi
            fi
        fi
    done < "$config_file"
fi

# ── Model / effort flags ──────────────────────────────────────────────────────
# claude takes --model and --effort as two flags. cursor-agent takes --model but
# has no --effort: it carries effort inside the model string as a bracket
# override, e.g. 'claude-opus-4-8[context=1m,effort=high]'. Dropping an effort:
# silently would leave the config looking honoured, so it warns instead.
# codex/opencode take neither and are left unchanged.
agent_model_args=""
case "$agent_binary" in
    claude)
        [ -n "$agent_model" ] && agent_model_args="--model $agent_model"
        [ -n "$agent_effort" ] && agent_model_args="$agent_model_args --effort $agent_effort"
        ;;
    cursor-agent)
        [ -n "$agent_model" ] && agent_model_args="--model $agent_model"
        if [ -n "$agent_effort" ]; then
            echo "dispatch.sh: warning - cursor-agent has no --effort flag. Put it in the model string instead, e.g. model: \"${agent_model}[effort=${agent_effort}]\". Ignoring effort=$agent_effort."
        fi
        ;;
esac

# Flags every cursor-agent launch needs, fresh or resumed.
#   -p                     headless; same flag claude uses
#   --force                skip permission prompts AND the workspace-trust gate.
#                          Without it cursor-agent prints a trust notice and
#                          exits 0 having done nothing -- a silent no-op that
#                          looks exactly like a healthy dispatch.
#   --approve-mcps         otherwise the backlog MCP is "not loaded (needs
#                          approval)" and the agent cannot read or edit tasks.
#   --output-format stream-json
#                          NDJSON to the dispatch log: tool_call/thinking events
#                          for the live panel, plus session_id and token usage in
#                          the final result, so nothing has to scrape a transcript.
cursor_flags="-p --force --approve-mcps --output-format stream-json"

# Flags every claude launch needs. `--output-format stream-json` makes the
# dispatch log a real feed -- tool calls, usage and timestamps -- instead of the
# single block of closing prose plain `-p` writes when the agent is already
# finished. The live agent panel reads this log, so without it every claude pane
# sits empty for the whole run and then prints one paragraph.
# `--verbose` is not optional: claude refuses stream-json under --print without
# it ("--output-format=stream-json requires --verbose").
claude_flags="-p --dangerously-skip-permissions --output-format stream-json --verbose"

echo "dispatch.sh: task=${TASK_ID:-?} status=${NEW_STATUS:-?} agent=$agent_name binary=$agent_binary"

# ── Rework detection (claude only) ───────────────────────────────────────────
# Resume the coder's previous session when the task returns to In Progress
# after a review with CHANGES REQUESTED. This preserves the full implementation
# context in the session history; the rework message is minimal.
is_resume_capable=0
if [ "$agent_binary" = "claude" ] || [ "$agent_binary" = "codex" ] || \
   [ "$agent_binary" = "opencode" ] || [ "$agent_binary" = "cursor-agent" ]; then
    is_resume_capable=1
fi

is_coder_rework=0
if [ "$is_resume_capable" = "1" ] && \
   [ "${NEW_STATUS:-}" = "In Progress" ] && \
   [ -n "$coder_session_id" ] && \
   grep -q 'CHANGES REQUESTED' "$task_file" 2>/dev/null; then
    is_coder_rework=1
fi

is_reviewer_resume=0
if [ "$is_resume_capable" = "1" ] && \
   [ "${NEW_STATUS:-}" = "In Review" ] && \
   [ -n "$reviewer_session_id" ]; then
    is_reviewer_resume=1
fi

# ── Per-agent launch ─────────────────────────────────────────────────────────
# The agent runs in the task's repository when it names one, and at the project
# root otherwise. It can still reach the backlog either way: the CLI and the MCP
# server find the project by walking UP from the working directory, and they do
# not stop at a git boundary, so a hub backlog above the repos stays reachable
# from inside any of them.
(
    cd "$agent_workdir"
    if [ "$is_coder_rework" = "1" ]; then
        rework_msg="The reviewer requested changes on task ${TASK_ID:-?}. Read the task via the Backlog.md MCP (task_view), find the latest Review section with CHANGES REQUESTED, address every finding, run the tests, and move the task back to In Review when done."
        rework_path="$log_file.rework"
        printf '%s' "$rework_msg" > "$rework_path"
        echo "dispatch.sh: coder rework - resuming session $coder_session_id"
        if [ "$agent_binary" = "codex" ]; then
            nohup codex exec resume "$coder_session_id" - \
                < "$rework_path" > "$log_file" 2> "$log_file.err" &
        elif [ "$agent_binary" = "cursor-agent" ]; then
            # shellcheck disable=SC2086 # intentional word-splitting of optional flags
            nohup cursor-agent $cursor_flags --resume "$coder_session_id" $agent_model_args \
                < "$rework_path" > "$log_file" 2> "$log_file.err" &
        elif [ "$agent_binary" = "opencode" ]; then
            nohup opencode run --dangerously-skip-permissions -s "$coder_session_id" \
                -f "$rework_path" -- 'Read and follow the attached instructions.' \
                > "$log_file" 2> "$log_file.err" &
        else
            # shellcheck disable=SC2086 # intentional word-splitting of optional flags
            nohup claude --resume "$coder_session_id" $claude_flags $agent_model_args \
                < "$rework_path" > "$log_file" 2> "$log_file.err" &
        fi
        : # nohup already detaches; `disown` is a bash builtin dash does not have
    elif [ "$is_reviewer_resume" = "1" ]; then
        resume_msg="The coder has addressed the findings on task ${TASK_ID:-?}. Re-read the task via the Backlog.md MCP (task_view), verify every fix, run the tests, and move to Human Review if everything passes or request more changes if issues remain."
        resume_path="$log_file.resume"
        printf '%s' "$resume_msg" > "$resume_path"
        echo "dispatch.sh: reviewer resume - resuming session $reviewer_session_id"
        if [ "$agent_binary" = "codex" ]; then
            nohup codex exec resume "$reviewer_session_id" - \
                < "$resume_path" > "$log_file" 2> "$log_file.err" &
        elif [ "$agent_binary" = "cursor-agent" ]; then
            # shellcheck disable=SC2086 # intentional word-splitting of optional flags
            nohup cursor-agent $cursor_flags --resume "$reviewer_session_id" $agent_model_args \
                < "$resume_path" > "$log_file" 2> "$log_file.err" &
        elif [ "$agent_binary" = "opencode" ]; then
            nohup opencode run --dangerously-skip-permissions -s "$reviewer_session_id" \
                -f "$resume_path" -- 'Read and follow the attached instructions.' \
                > "$log_file" 2> "$log_file.err" &
        else
            # shellcheck disable=SC2086 # intentional word-splitting of optional flags
            nohup claude --resume "$reviewer_session_id" $claude_flags $agent_model_args \
                < "$resume_path" > "$log_file" 2> "$log_file.err" &
        fi
        : # nohup already detaches; `disown` is a bash builtin dash does not have
    else
    case "$agent_binary" in
        claude)
            # shellcheck disable=SC2086 # intentional word-splitting of optional flags
            nohup claude $claude_flags $agent_model_args \
                < "$prompt_path" > "$log_file" 2> "$log_file.err" &
            ;;
        codex)
            # --json emits thread.started with thread_id so the coder can
            # capture its session ID. `-` reads the prompt from stdin.
            nohup codex exec --json --skip-git-repo-check --yolo - \
                < "$prompt_path" > "$log_file" 2> "$log_file.err" &
            ;;
        opencode)
            nohup opencode run --dangerously-skip-permissions \
                -f "$prompt_path" -- 'Read and follow the attached instructions completely.' \
                > "$log_file" 2> "$log_file.err" &
            ;;
        cursor-agent)
            # Reads the prompt from stdin, like claude -- the positional
            # [prompt...] argument is not used.
            # shellcheck disable=SC2086 # intentional word-splitting of optional flags
            nohup cursor-agent $cursor_flags $agent_model_args \
                < "$prompt_path" > "$log_file" 2> "$log_file.err" &
            ;;
        *)
            # Treat as an absolute or relative path; assume claude-compatible stdin.
            nohup "$agent_binary" -p --dangerously-skip-permissions \
                < "$prompt_path" > "$log_file" 2> "$log_file.err" &
            ;;
    esac
    fi
    # Record the agent's pid. /api/agent-status and /api/agent-activity both
    # resolve liveness from `<log>.pid` and treat an unreadable pid as "nothing
    # is running", so without this the live agent panel is permanently empty on
    # POSIX -- the board shows no panes however many agents are out. dispatch.ps1
    # has always written it; this side only ever *pruned* the file, in the log
    # retention list, which is how the gap stayed invisible.
    #
    # One write here rather than one per branch: every launch above backgrounds
    # exactly one process, and `$!` is the most recent one whichever branch ran.
    # nohup execs the agent, so this is the agent's own pid, not a wrapper that
    # exits immediately.
    printf '%s' "$!" > "$log_file.pid"
) > /dev/null 2>&1
