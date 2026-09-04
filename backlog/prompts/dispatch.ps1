# Backlog.md status-change dispatcher (PowerShell 5.1 compatible)
#
# Set in backlog.config.yml:
#   shell: "powershell"
#   onStatusChange: 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PWD\backlog\prompts\dispatch.ps1"'
#
# Env vars injected by Backlog.md: TASK_ID, OLD_STATUS, NEW_STATUS, TASK_TITLE.

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$promptsDir = $scriptDir

# ── Force subscription auth for dispatched agents ────────────────────────────
# If the project it manages also uses the Anthropic API, its ANTHROPIC_API_KEY
# tends to reach this process's environment (a repo-root .env, a compose file, or
# the shell that started the watcher). The Claude CLI prefers an API key over the
# subscription OAuth token whenever that var is present, so every dispatched
# coder/reviewer silently bills the API account instead of the subscription — a
# cost spike, then "Credit balance is too low" once it runs dry.
#
# The dispatcher never calls the Anthropic API itself and Codex/opencode ignore
# this var, so stripping it here is free and forces every dispatched Claude onto
# the subscription token. The application's own key is untouched: this only
# affects the environment of the agents launched below.
Remove-Item Env:\ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

# ── Prompt file selection ────────────────────────────────────────────────────
if ($env:NEW_STATUS -eq 'In Progress') {
    $promptStem = 'code'
} elseif ($env:NEW_STATUS -eq 'In Review') {
    $promptStem = 'review'
} elseif ($env:NEW_STATUS -eq 'Human Review') {
    $promptStem = 'ready'
} else {
    exit 0
}

if ($env:BACKLOG_DISPATCH_MODE -eq 'test') {
    $suffix = '.test.md'
} else {
    $suffix = '.md'
}

$promptFile = Join-Path $promptsDir "$promptStem$suffix"
if (-not (Test-Path $promptFile)) {
    Write-Warning "dispatch.ps1: prompt file not found: $promptFile"
    exit 0
}

$promptBody = Get-Content -Path $promptFile -Raw
$fullPrompt = @"
$promptBody

---
Task: $env:TASK_ID -- $env:TASK_TITLE
Status: $env:OLD_STATUS -> $env:NEW_STATUS
"@

# ── Log file ─────────────────────────────────────────────────────────────────
$logDir = Join-Path $promptsDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$safeTaskId = ($env:TASK_ID -replace '[<>:"/\\|?*\s]+', '_')
if (-not $safeTaskId) { $safeTaskId = 'unknown' }
$safeStatus = ($env:NEW_STATUS -replace '[<>:"/\\|?*\s]+', '_')
if (-not $safeStatus) { $safeStatus = 'unknown' }
$logFile = Join-Path $logDir "$timestamp-$PID-$safeTaskId-$safeStatus.log"

$promptPath = "$logFile.prompt"
[System.IO.File]::WriteAllText($promptPath, $fullPrompt, (New-Object System.Text.UTF8Encoding $false))

if ($env:BACKLOG_DISPATCH_DRY_RUN -eq '1') { exit 0 }

# ── Deduplication guard ───────────────────────────────────────────────────────
# The onStatusChange hook can fire more than once for the same event when the
# in-process dispatch and the file-watcher dispatch race.
#
# ⚠️ This guard used to embed the CURRENT SECOND in the lock filename, making the
# window exactly 1 second. Three dispatches arrived at 10:03:18, 10:03:21 and
# 10:03:21: the two sharing a second deduped correctly, but 10:03:18 and 10:03:21
# hashed to DIFFERENT keys — so two agents launched and attached to the same
# worktree simultaneously, producing two parallel implementations of one feature
# (duplicate request classes, duplicate services, an orphaned controller
# dependency). Orphans of that kind still compile and still pass tests, because
# nothing executes them.
#
# Fix: the lock name is keyed ONLY on (taskId, status) — no timestamp — and
# staleness is decided by the lock file's AGE, not by its name. A second dispatch
# inside the TTL is suppressed regardless of which second it lands on.
$dedupeTtlSeconds = 90
$dedupeLock = Join-Path $logDir "$safeTaskId-$safeStatus.dedup"

# Clear the lock first if it is older than the TTL, so a legitimate re-dispatch
# later (rework, relaunch of a stranded session) is never blocked forever.
#
# TOCTOU: Test-Path can succeed and the file be gone before Get-Item runs, when
# two dispatches race. With $ErrorActionPreference='Stop' that THROWS and the
# whole callback dies — observed as a wall of "Status change callback failed …
# PathNotFound … Get-Item" that eventually took the Backlog.md server down.
# -ErrorAction SilentlyContinue on Get-Item is not enough on its own: it returns
# $null and then .LastWriteTime throws instead. Fetch the item ONCE, null-check
# it, and swallow anything unexpected — failing to clear a stale lock must never
# be fatal to dispatch.
try {
    $lockItem = Get-Item $dedupeLock -ErrorAction SilentlyContinue
    if ($null -ne $lockItem) {
        $lockAge = (Get-Date) - $lockItem.LastWriteTime
        if ($lockAge.TotalSeconds -gt $dedupeTtlSeconds) {
            Remove-Item $dedupeLock -Force -ErrorAction SilentlyContinue
        }
    }
} catch {
    Write-Host "dispatch.ps1: stale-lock check skipped ($($_.Exception.Message))"
}

# File::Open with CreateNew is atomic on Windows: the first caller wins, the
# second gets an IOException and exits — no second agent is launched.
try {
    $s = [System.IO.File]::Open($dedupeLock,
             [System.IO.FileMode]::CreateNew,
             [System.IO.FileAccess]::ReadWrite,
             [System.IO.FileShare]::None)
    $s.Close()
} catch {
    Write-Host "dispatch.ps1: duplicate suppressed for $env:TASK_ID -> $env:NEW_STATUS (within ${dedupeTtlSeconds}s dedup window)"
    exit 0
}

# ── Ping-pong loop guard ──────────────────────────────────────────────────────
# The dedup lock only stops SIMULTANEOUS dispatches. It does nothing about a task
# bouncing coder -> In Review -> reviewer -> In Progress -> coder forever, each
# hop a legitimate, well-spaced dispatch.
#
# One task did exactly that and burned TWO 5-hour provider usage windows before a
# human noticed. Neither agent was misbehaving — the coder fixed what was asked,
# the reviewer found something new each round. Nothing in the system was counting.
#
# Count the round trips per task and hard-stop past the threshold. A human then
# decides whether the task needs re-scoping, a different agent, or splitting.
# Reset by deleting the counter files (or let them age out after 24h).
#
# ⚠️ MUST be race-safe. A read -> increment -> write on a single counter file is a
# lost-update race: when the hook storms (17 fires for ONE status change were
# observed, caused by several Backlog.md server processes each firing
# onStatusChange), every process reads the SAME value, every one writes value+1,
# and every one concludes it is under the limit.
#
# Instead, each dispatch CLAIMS a hop number by atomically creating
# "<task>.hop-NNN". File::Open with CreateNew is atomic, so exactly one process
# can ever own a given number — no read-modify-write, nothing to race. The
# claimed number IS the hop count.
$maxRoundTrips = 6
# A crash-recovery restart is NOT a round trip and must not consume the budget.
# watchdog.ps1 re-fires a dead agent with OLD_STATUS = NEW_STATUS, a signature a
# real transition never produces. Counting those as hops fenced one task after
# only ONE review round: of its 7 hops, 3 were watchdog restarts. This guard
# exists to stop coder/reviewer DISAGREEMENT, so it must count disagreement, not
# crashes. The watchdog has its own independent retry cap for runaway restarts.
$isCrashRecovery = ($env:OLD_STATUS -eq $env:NEW_STATUS)
if (-not $isCrashRecovery -and ($env:NEW_STATUS -eq 'In Progress' -or $env:NEW_STATUS -eq 'In Review')) {
    try {
        # Age out a finished/abandoned cycle so a task is never blocked forever.
        Get-ChildItem $logDir -Filter "$safeTaskId.hop-*" -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-24) } |
            Remove-Item -Force -ErrorAction SilentlyContinue

        $trips = 0
        for ($n = 1; $n -le ($maxRoundTrips + 1); $n++) {
            $hopFile = Join-Path $logDir ("{0}.hop-{1:D3}" -f $safeTaskId, $n)
            try {
                $hs = [System.IO.File]::Open($hopFile,
                          [System.IO.FileMode]::CreateNew,
                          [System.IO.FileAccess]::ReadWrite,
                          [System.IO.FileShare]::None)
                $hs.Close()
                $trips = $n
                break
            } catch {
                # Someone already owns this hop number; try the next one.
                continue
            }
        }

        if ($trips -eq 0 -or $trips -gt $maxRoundTrips) {
            Write-Host "dispatch.ps1: LOOP GUARD - $env:TASK_ID has exhausted $maxRoundTrips coder/reviewer hops. NOT dispatching."
            Write-Host "dispatch.ps1: a human must decide (re-scope, reassign, or split). Reset with: Remove-Item '$logDir\$safeTaskId.hop-*'"
            exit 0
        }
        if ($trips -eq $maxRoundTrips) {
            Write-Host "dispatch.ps1: WARNING - $env:TASK_ID is on hop $trips of $maxRoundTrips; the next one is blocked."
        }
    } catch {
        Write-Host "dispatch.ps1: loop-guard bookkeeping failed ($($_.Exception.Message)) - continuing"
    }
}

# Prune dedup files well past the TTL so they don't accumulate.
Get-ChildItem $logDir -Filter '*.dedup' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddSeconds(-($dedupeTtlSeconds * 4)) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

# ── Dispatch-log retention ────────────────────────────────────────────────────
# Nothing used to prune the dispatch logs themselves (.log/.err/.pid/.prompt/
# .rework/.resume), so they accumulated indefinitely. One deployment's log
# directory reached 48,967 files / 727 MB and had to be moved out by hand: a
# retry storm on a single task wrote 29,720 files in one day (~3,000/hour) while
# the normal rate had been 50-300/day for months. A directory that large is slow
# to enumerate and makes any watcher over the project tree expensive.
#
# Keep 14 days — far longer than any post-mortem needs, and still bounded at a
# few thousand files at normal rates. Capped per run so a huge backlog is chipped
# away rather than stalling a dispatch, and wrapped so a pruning failure can
# never block one.
$logRetentionDays = 14
$maxPrunePerRun = 500
try {
    Get-ChildItem $logDir -File -ErrorAction SilentlyContinue |
        Where-Object {
            $_.LastWriteTime -lt (Get-Date).AddDays(-$logRetentionDays) -and
            $_.Extension -in @('.log', '.err', '.pid', '.prompt', '.rework', '.resume')
        } |
        Select-Object -First $maxPrunePerRun |
        Remove-Item -Force -ErrorAction SilentlyContinue
} catch {
    Write-Host "dispatch.ps1: log pruning skipped ($($_.Exception.Message))"
}

# ── Agent resolution ─────────────────────────────────────────────────────────
# Tasks without `agent:` in frontmatter are human tasks -- skip dispatch.
# Exception: Human Review always fires the notifier (ready.md).

$projectRoot = (Resolve-Path (Join-Path $scriptDir '..\..') ).Path
$tasksDir = Join-Path $projectRoot 'backlog\tasks'

# ── Alias → binary resolution ─────────────────────────────────────────────────
# Read the agents: block from backlog/config.yml. If the task's agent value
# matches a configured alias, use the corresponding binary; otherwise treat
# the value as a raw binary name (back-compat with existing tasks).
$configFile = Join-Path $projectRoot 'backlog\config.yml'
$aliasMap = @{}
$modelMap = @{}
$effortMap = @{}
if (Test-Path $configFile) {
    $configContent = Get-Content $configFile -Raw
    # Extract the agents: block line by line — simple enough without gray-matter.
    # `alias:` opens a new entry; `binary:`/`model:`/`effort:` attach to the
    # current alias (model/effort follow binary in the YAML, so we keep the
    # alias as context until the next entry rather than clearing it on binary).
    $inAgents = $false
    $currentAlias = ''
    foreach ($line in $configContent -split '\r?\n') {
        if ($line -match '^agents:') {
            $inAgents = $true
            continue
        }
        if ($inAgents) {
            # Stop at the next top-level key (not indented).
            if ($line -match '^[A-Za-z_]') { $inAgents = $false; continue }
            if ($line -match '^\s+-\s+alias:\s*[''"]?([^''"]+)[''"]?\s*$') {
                $currentAlias = $matches[1].Trim()
            } elseif ($currentAlias -ne '' -and $line -match '^\s+binary:\s*[''"]?([^''"]+)[''"]?\s*$') {
                $aliasMap[$currentAlias] = $matches[1].Trim()
            } elseif ($currentAlias -ne '' -and $line -match '^\s+model:\s*[''"]?([^''"]+)[''"]?\s*$') {
                $modelMap[$currentAlias] = $matches[1].Trim()
            } elseif ($currentAlias -ne '' -and $line -match '^\s+effort:\s*[''"]?([^''"]+)[''"]?\s*$') {
                $effortMap[$currentAlias] = $matches[1].Trim()
            }
        }
    }
}
$taskFile = Get-ChildItem $tasksDir -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ilike "*$env:TASK_ID*" } |
    Select-Object -First 1

$taskAgentName = ''
$taskReviewAgentName = ''
$coderSessionId = ''
$reviewerSessionId = ''
if ($taskFile) {
    $taskContent = Get-Content $taskFile.FullName -Raw
    if ($taskContent -match '(?m)^agent:\s*[''"]?([^''"\r\n]+?)[''"]?\s*$') {
        $taskAgentName = $matches[1].Trim()
    }
    if ($taskContent -match '(?m)^reviewAgent:\s*[''"]?([^''"\r\n]+?)[''"]?\s*$') {
        $taskReviewAgentName = $matches[1].Trim()
    }
    # Coder session ID — written by the coder in a "## Session" block.
    # Take the LAST match in case there were multiple rounds.
    # Coder session ID — matches both UUID (claude/codex) and ses_* (opencode).
    $coderMatches = [regex]::Matches($taskContent, '(?m)^Session ID:\s*([a-f0-9-]{36}|ses_[A-Za-z0-9]+)')
    if ($coderMatches.Count -gt 0) {
        $coderSessionId = $coderMatches[$coderMatches.Count - 1].Groups[1].Value.Trim()
    }
    # Reviewer session ID — matches both UUID and ses_* formats.
    $reviewerMatches = [regex]::Matches($taskContent, '(?m)^Reviewer Session ID:\s*([a-f0-9-]{36}|ses_[A-Za-z0-9]+)')
    if ($reviewerMatches.Count -gt 0) {
        $reviewerSessionId = $reviewerMatches[$reviewerMatches.Count - 1].Groups[1].Value.Trim()
    }
}

# ── Record token usage of the session that just finished ──────────────────────
# OLD_STATUS tells us who was working: In Progress -> coder, In Review -> reviewer.
# token-report.ps1 reads the count out-of-band from the agent's own transcript
# (zero extra agent tokens). A reporting failure must never block dispatch.
try {
    $finishedRole = ''; $finishedSession = ''; $finishedAlias = ''
    if ($env:OLD_STATUS -eq 'In Progress') {
        $finishedRole = 'coder'; $finishedSession = $coderSessionId; $finishedAlias = $taskAgentName
    } elseif ($env:OLD_STATUS -eq 'In Review') {
        $finishedRole = 'reviewer'; $finishedSession = $reviewerSessionId
        $finishedAlias = if ($taskReviewAgentName) { $taskReviewAgentName } else { $taskAgentName }
    }
    if ($finishedSession -ne '' -and $finishedAlias -ne '') {
        $finishedBinary = if ($aliasMap.ContainsKey($finishedAlias)) { $aliasMap[$finishedAlias] } else { $finishedAlias.ToLower() }
        & (Join-Path $scriptDir 'token-report.ps1') `
            -TaskId $env:TASK_ID -SessionId $finishedSession -Role $finishedRole `
            -AgentBinary $finishedBinary -ProjectRoot $projectRoot
    }
} catch {
    Write-Host "dispatch.ps1: token-report skipped - $($_.Exception.Message)"
}

if ((-not $taskAgentName) -and ($env:NEW_STATUS -ne 'Human Review')) {
    exit 0
}

if ($env:NEW_STATUS -eq 'In Review') {
    if ($taskReviewAgentName) { $agentName = $taskReviewAgentName } else { $agentName = $taskAgentName }
} elseif ($env:NEW_STATUS -eq 'Human Review') {
    if ($taskAgentName) { $agentName = $taskAgentName } else { $agentName = 'claude' }
} else {
    $agentName = $taskAgentName
}

# Resolve alias → binary if configured; otherwise use as-is.
$agentBinary = if ($aliasMap.ContainsKey($agentName)) { $aliasMap[$agentName] } else { $agentName }
Write-Host "dispatch.ps1: task=$env:TASK_ID status=$env:NEW_STATUS agent=$agentName binary=$agentBinary"

# ── Deterministic MR creation on Human Review ─────────────────────────────────
# The reviewer agent is supposed to open the MR (review.md Step 6) but does so
# unreliably (esp. on the rework -> re-review resume path). Create it here too,
# deterministically and idempotently, so an approved task always gets its MR.
# create-mr.ps1 resolves the branch from the task notes, skips if an MR already
# exists, and never throws fatally. A failure here must not block the notifier.
if ($env:NEW_STATUS -eq 'Human Review') {
    try {
        $taskFilePath = if ($taskFile) { $taskFile.FullName } else { '' }
        & (Join-Path $scriptDir 'create-mr.ps1') `
            -TaskId $env:TASK_ID -ProjectRoot $projectRoot -TaskFile $taskFilePath
    } catch {
        Write-Host "dispatch.ps1: create-mr skipped - $($_.Exception.Message)"
    }
}

# ── Model / effort resolution (claude only) ───────────────────────────────────
# Per-agent model/effort from the config alias drive --model/--effort. Only
# claude supports these flags; codex/opencode launches are left unchanged.
$claudeModelArgs = @()
if ($agentBinary.ToLower() -eq 'claude') {
    if ($modelMap.ContainsKey($agentName) -and $modelMap[$agentName] -ne '') {
        $claudeModelArgs += @('--model', $modelMap[$agentName])
    }
    if ($effortMap.ContainsKey($agentName) -and $effortMap[$agentName] -ne '') {
        $claudeModelArgs += @('--effort', $effortMap[$agentName])
    }
}

# ── Role-scoped MCP config (claude only) ──────────────────────────────────────
# Every claude session was loading all 7 MCP servers from .mcp.json (gitlab's
# ~100 tool schemas + 4 cloudflare servers + playwright + backlog), inflating
# context before any work began. Scope the server set to what the role actually
# needs and pass it with --strict-mcp-config so .mcp.json is ignored:
#   coder (In Progress)   -> backlog + playwright
#   reviewer (In Review)  -> backlog + gitlab + playwright (gitlab for the MR)
#   notifier (Human Review) -> coder set (only needs backlog)
$claudeMcpArgs = @()
if ($agentBinary.ToLower() -eq 'claude') {
    if ($env:NEW_STATUS -eq 'In Review') {
        $mcpConfigFile = Join-Path $projectRoot '.claude\mcp-reviewer.json'
    } else {
        $mcpConfigFile = Join-Path $projectRoot '.claude\mcp-coder.json'
    }
    if (Test-Path $mcpConfigFile) {
        $claudeMcpArgs += @('--strict-mcp-config', '--mcp-config', $mcpConfigFile)
    } else {
        Write-Host "dispatch.ps1: MCP config not found ($mcpConfigFile) - falling back to .mcp.json"
    }
}

# ── Append resolved model/effort to the prompt context ────────────────────────
# The prompt file was written above (before agent resolution), so the model/
# effort the agent is launched with aren't in it yet. Append them now so the
# agent can copy exact values into its Session block. claude only — codex/
# opencode aren't launched with these flags and self-report. Not reached on the
# dry-run / dedup early exits (no launch happens there anyway).
if ($agentBinary.ToLower() -eq 'claude' -and (Test-Path $promptPath)) {
    $resolvedModel  = if ($modelMap.ContainsKey($agentName))  { $modelMap[$agentName] }  else { '' }
    $resolvedEffort = if ($effortMap.ContainsKey($agentName)) { $effortMap[$agentName] } else { '' }
    if ($resolvedModel -ne '' -or $resolvedEffort -ne '') {
        [System.IO.File]::AppendAllText($promptPath, "`nModel: $resolvedModel`nEffort: $resolvedEffort`n", (New-Object System.Text.UTF8Encoding $false))
    }
}

# ── Binary lookup ─────────────────────────────────────────────────────────────
if ($agentBinary.ToLower() -eq 'claude') {
    $candidates = @('claude.cmd', 'claude.exe', 'claude')
} elseif ($agentBinary.ToLower() -eq 'codex') {
    $candidates = @('codex.cmd', 'codex.exe', 'codex')
} elseif ($agentBinary.ToLower() -eq 'opencode') {
    $candidates = @('opencode.cmd', 'opencode.exe', 'opencode')
} else {
    $candidates = @($agentBinary)
}

$agentExec = $null
foreach ($candidate in $candidates) {
    $found = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) {
        $agentExec = $found.Source
        break
    }
}

if (-not $agentExec) {
    Write-Warning "dispatch.ps1: '$agentName' not found -- falling back to claude.cmd"
    $found = Get-Command 'claude.cmd' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) { $agentExec = $found.Source }
}

if (-not $agentExec) {
    Write-Warning "dispatch.ps1: no agent binary found. Cannot dispatch."
    exit 1
}

# ── Launch ────────────────────────────────────────────────────────────────────
# Claude reads the prompt from stdin (multi-line safe via -RedirectStandardInput).
# Codex and opencode require the prompt as a positional argument — they reject
# stdin redirection with "stdin is not a terminal".
# ── Rework detection (claude only) ───────────────────────────────────────────
# When a task returns to In Progress after a review, the coder should resume
# its previous session (retaining full implementation context) rather than
# starting from scratch. The rework message is minimal: just tell the agent
# to read the task and fix the reviewer's findings — everything else lives in
# the session history and in the task body via MCP.
#
# Conditions for --resume (post-review rework):
#   1. Agent is claude (Codex/opencode don't support --resume)
#   2. Status is "In Progress" (rework trigger)
#   3. A coder session ID exists in the task notes
#   4. The task body contains at least one "CHANGES REQUESTED" review block
#
# A second, distinct case is a stranded-retry: the coder's first run died
# (provider usage/rate limit) before ever reaching review, so there's no
# "CHANGES REQUESTED" block to match on. The dispatcher's stranded-agent
# recovery re-fires with OLD_STATUS=NEW_STATUS='In Progress' -- a signature
# that never occurs on a normal fresh dispatch (which is always
# To Do -> In Progress). When that signature is present and a coder session
# ID was already captured, resume that session instead of paying to re-read
# the whole repo from scratch.
#
$resumeCapableAgents = @('claude', 'codex', 'opencode')

$isPostReviewRework = $false
if ($resumeCapableAgents -contains $agentBinary.ToLower() -and
    $env:NEW_STATUS -eq 'In Progress' -and
    $coderSessionId -ne '' -and
    $taskContent -match 'CHANGES REQUESTED') {
    $isPostReviewRework = $true
}

# Resuming a stranded session is safe ONLY when something EXTERNAL killed it
# mid-work. If it exited cleanly believing it had already finished, resuming
# reproduces that false belief -- a poisoned-resume loop that cost one task two
# dispatch cycles, the resumed coder replying "already processed for that review
# round" and never committing.
#
# Resolve it by evidence rather than by the signature alone: read the PREVIOUS
# launch log's tail.
#   provider-limit / hard-error signature -> died mid-work, resume keeps context
#   anything else (including a clean exit) -> start FRESH, the context is suspect
$strandedLogHasLimitSignature = $false
$strandedLogReason = 'no previous coder log found'
$prevCoderLog = Get-ChildItem $logDir -Filter "*$safeTaskId-In_Progress.log" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -ne $logFile } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($prevCoderLog) {
    $prevTail = (Get-Content $prevCoderLog.FullName -Tail 20 -ErrorAction SilentlyContinue) -join "`n"
    if ($prevTail -match '(?i)(session limit|usage limit|rate limit|quota|insufficient balance|credit balance|turn\.failed|context low)') {
        $strandedLogHasLimitSignature = $true
        $strandedLogReason = "provider-limit signature in $($prevCoderLog.Name)"
    } else {
        $strandedLogReason = "no provider-limit signature in $($prevCoderLog.Name)"
    }
}

$isStrandedRetry = $false
if ($resumeCapableAgents -contains $agentBinary.ToLower() -and
    $env:OLD_STATUS -eq 'In Progress' -and
    $env:NEW_STATUS -eq 'In Progress' -and
    $coderSessionId -ne '' -and
    -not $isPostReviewRework) {
    if ($strandedLogHasLimitSignature) {
        $isStrandedRetry = $true
    } else {
        Write-Host "dispatch.ps1: stranded retry for $env:TASK_ID will launch FRESH, not resume ($strandedLogReason)"
    }
}

$isCoderRework = $isPostReviewRework -or $isStrandedRetry

$isReviewerResume = $false
if ($resumeCapableAgents -contains $agentBinary.ToLower() -and
    $env:NEW_STATUS -eq 'In Review' -and
    $reviewerSessionId -ne '') {
    $isReviewerResume = $true
}

if ($isCoderRework) {
    if ($isStrandedRetry) {
        $reworkMessage = "Your previous session on task $env:TASK_ID was interrupted before finishing (e.g. a provider usage/rate limit) and no implementation was committed. Read the task via the Backlog.md MCP (task_view) and resume from where you left off -- you may already have useful context on the codebase in this session. Finish the implementation, run the tests, commit, and move the task to In Review when done."
    } else {
        $reworkMessage = "The reviewer requested changes on task $env:TASK_ID. Read the task via the Backlog.md MCP (task_view), find the latest Review section with CHANGES REQUESTED, address every finding, run the tests, and move the task back to In Review when done."
    }
    $reworkPath = "$logFile.rework"
    [System.IO.File]::WriteAllText($reworkPath, $reworkMessage, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "dispatch.ps1: coder rework - resuming session $coderSessionId"
    if ($agentBinary.ToLower() -eq 'codex') {
        # codex exec resume <id> - reads follow-up from stdin.
        # --json, --skip-git-repo-check, --yolo must be explicit on resume:
        # without them Codex activates the interactive console path which
        # fails headlessly (sandbox spawn error + MCP approval cancellation).
        $agentArgs = @('exec', '--json', '--skip-git-repo-check', '--yolo', 'resume', $coderSessionId, '-')
        Start-Process `
            -FilePath $agentExec `
            -ArgumentList $agentArgs `
            -RedirectStandardInput $reworkPath `
            -RedirectStandardOutput $logFile `
            -RedirectStandardError "$logFile.err" `
            -WindowStyle Hidden `
            -WorkingDirectory $projectRoot -PassThru | ForEach-Object { $script:agentProc = $_ }
    } elseif ($agentBinary.ToLower() -eq 'opencode') {
        $agentArgs = @('run', '--dangerously-skip-permissions', '-s', $coderSessionId, '-f', $reworkPath, '--', 'Read and follow the attached instructions.')
        Start-Process `
            -FilePath $agentExec `
            -ArgumentList $agentArgs `
            -RedirectStandardOutput $logFile `
            -RedirectStandardError "$logFile.err" `
            -WindowStyle Hidden `
            -WorkingDirectory $projectRoot -PassThru | ForEach-Object { $script:agentProc = $_ }
    } else {
        $agentArgs = @('--resume', $coderSessionId, '--dangerously-skip-permissions') + $claudeModelArgs + $claudeMcpArgs
        Start-Process `
            -FilePath $agentExec `
            -ArgumentList $agentArgs `
            -RedirectStandardInput $reworkPath `
            -RedirectStandardOutput $logFile `
            -RedirectStandardError "$logFile.err" `
            -WindowStyle Hidden `
            -WorkingDirectory $projectRoot -PassThru | ForEach-Object { $script:agentProc = $_ }
    }
} elseif ($isReviewerResume) {
    $reviewResumeMessage = "The coder has addressed the findings on task $env:TASK_ID. Re-read the task via the Backlog.md MCP (task_view), verify every fix, and run the tests. If anything still fails, request more changes (set status In Progress). If everything passes, you MUST complete the FULL approval routing from review.md Step 6 before finishing. Do NOT just move the status. In order: (1) check the satisfied acceptance criteria, (2) ensure the implementation branch is pushed to origin, (3) create the GitLab Merge Request into main via the gitlab MCP create_merge_request with dry_run set to false, using the implementation branch recorded in the task notes as source_branch and NOT the git current branch, then (4) set status to Human Review. If you cannot create the MR, append a clearly-flagged note that the MR was NOT created and still proceed. Never skip the MR step silently."
    $reviewResumePath = "$logFile.resume"
    [System.IO.File]::WriteAllText($reviewResumePath, $reviewResumeMessage, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "dispatch.ps1: reviewer resume - resuming session $reviewerSessionId"
    if ($agentBinary.ToLower() -eq 'codex') {
        $agentArgs = @('exec', '--json', '--skip-git-repo-check', '--yolo', 'resume', $reviewerSessionId, '-')
        Start-Process `
            -FilePath $agentExec `
            -ArgumentList $agentArgs `
            -RedirectStandardInput $reviewResumePath `
            -RedirectStandardOutput $logFile `
            -RedirectStandardError "$logFile.err" `
            -WindowStyle Hidden `
            -WorkingDirectory $projectRoot -PassThru | ForEach-Object { $script:agentProc = $_ }
    } elseif ($agentBinary.ToLower() -eq 'opencode') {
        $agentArgs = @('run', '--dangerously-skip-permissions', '-s', $reviewerSessionId, '-f', $reviewResumePath, '--', 'Read and follow the attached instructions.')
        Start-Process `
            -FilePath $agentExec `
            -ArgumentList $agentArgs `
            -RedirectStandardOutput $logFile `
            -RedirectStandardError "$logFile.err" `
            -WindowStyle Hidden `
            -WorkingDirectory $projectRoot -PassThru | ForEach-Object { $script:agentProc = $_ }
    } else {
        $agentArgs = @('--resume', $reviewerSessionId, '--dangerously-skip-permissions') + $claudeModelArgs + $claudeMcpArgs
        Start-Process `
            -FilePath $agentExec `
            -ArgumentList $agentArgs `
            -RedirectStandardInput $reviewResumePath `
            -RedirectStandardOutput $logFile `
            -RedirectStandardError "$logFile.err" `
            -WindowStyle Hidden `
            -WorkingDirectory $projectRoot -PassThru | ForEach-Object { $script:agentProc = $_ }
    }
} elseif ($agentBinary.ToLower() -eq 'codex') {
    # First run: codex exec reads the prompt from stdin via `-`.
    # --json captures thread.started so the coder can extract the session ID.
    # --skip-git-repo-check lets it run outside a git repo root.
    # --yolo = unattended (no confirmation prompts).
    $agentArgs = @('exec', '--json', '--skip-git-repo-check', '--yolo', '-')
    Start-Process `
        -FilePath $agentExec `
        -ArgumentList $agentArgs `
        -RedirectStandardInput $promptPath `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError "$logFile.err" `
        -WindowStyle Hidden `
        -WorkingDirectory $projectRoot -PassThru | ForEach-Object { $script:agentProc = $_ }
} elseif ($agentBinary.ToLower() -eq 'opencode') {
    # opencode run: attach the prompt file with -f.
    # The message positional must come AFTER -- to prevent opencode from
    # treating it as additional -f arguments.
    $agentArgs = @('run', '--dangerously-skip-permissions', '-f', $promptPath, '--', 'Read and follow the attached instructions completely.')
    Start-Process `
        -FilePath $agentExec `
        -ArgumentList $agentArgs `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError "$logFile.err" `
        -WindowStyle Hidden `
        -WorkingDirectory $projectRoot -PassThru | ForEach-Object { $script:agentProc = $_ }
} else {
    # Claude: new session, prompt via stdin.
    $agentArgs = @('-p', '--dangerously-skip-permissions') + $claudeModelArgs + $claudeMcpArgs
    Start-Process `
        -FilePath $agentExec `
        -ArgumentList $agentArgs `
        -RedirectStandardInput $promptPath `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError "$logFile.err" `
        -WindowStyle Hidden `
        -WorkingDirectory $projectRoot -PassThru | ForEach-Object { $script:agentProc = $_ }
}

# Write the launched agent's PID so the web UI can check whether the process is
# still alive. The dispatch.ps1 PID ($PID in the filename) exits immediately after
# Start-Process — the .pid file holds the actual agent process's ID.
if ($script:agentProc) {
    "$($script:agentProc.Id)" | Set-Content "$logFile.pid" -Encoding utf8 -NoNewline
}
