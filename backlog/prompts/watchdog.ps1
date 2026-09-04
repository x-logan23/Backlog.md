# Stranded-agent watchdog (PowerShell 5.1 compatible)
#
# dispatch.ps1 is event-driven: it launches an agent when a task changes status
# and then exits. If that agent process later dies -- provider session limit,
# a crashed MCP subprocess, a machine hiccup -- NOTHING notices. The task sits
# in "In Progress" or "In Review" forever with no process behind it.
#
# In one deployment that happened repeatedly: 8 dispatch logs contained
# "You've hit your session limit", and one reviewer completed an entire review
# and then died because its `backlog mcp start` subprocess was unavailable, so
# the verdict was never written. Every recovery that night was done by hand.
#
# dispatch.ps1 ALREADY knows how to recover -- it resumes the coder's session
# on the OLD_STATUS=NEW_STATUS='In Progress' signature ($isStrandedRetry), and
# resumes the reviewer whenever NEW_STATUS='In Review' and a reviewer session
# id is recorded. What was missing is something to notice and fire it. That is
# all this script does.
#
# NOTE: the automated test loop is already self-healing and is NOT this
# script's business -- run-full-suite.ps1 runs detached and bounces a red leg
# back to In Progress on its own (see code.md). This only covers dead agent
# PROCESSES.
#
# Usage:
#   watchdog.ps1 -ProjectRoot D:\path\to\your-project            # act
#   watchdog.ps1 -ProjectRoot ... -DryRun                     # report only
#   watchdog.ps1 -ProjectRoot ... -GraceMinutes 15 -MaxRetries 2
#
# Intended to run on a timer (Task Scheduler, every ~10 minutes). It is
# stateless apart from the per-task retry markers in logs/, and safe to run
# concurrently with dispatch.ps1: dispatch's own 90s dedup lock and the
# hop-claim loop guard both still apply to anything this fires.

param(
    [Parameter(Mandatory = $true)] [string] $ProjectRoot,
    [int] $GraceMinutes = 10,
    [int] $MaxRetries = 3,
    [switch] $DryRun
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = $PSScriptRoot
$logDir = Join-Path $scriptDir 'logs'
$tasksDir = Join-Path $ProjectRoot 'backlog\tasks'
$dispatchScript = Join-Path $scriptDir 'dispatch.ps1'

function Write-WD([string] $msg) {
    $line = "watchdog.ps1: $msg"
    Write-Host $line
    try {
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -Path (Join-Path $logDir 'watchdog.log') -Value "$stamp  $msg" -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch { }
}

if (-not (Test-Path $tasksDir)) { Write-WD "FATAL: tasks dir not found: $tasksDir"; exit 1 }
if (-not (Test-Path $dispatchScript)) { Write-WD "FATAL: dispatch.ps1 not found: $dispatchScript"; exit 1 }
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Only these two statuses have a live agent behind them. "Testing" is handled
# by run-full-suite.ps1 (detached, self-recovering); every other status is a
# resting state with no process to lose.
$watchedStatuses = @('In Progress', 'In Review')

$acted = 0
$checked = 0
# Marker basenames for tasks that are still in a watched status this run.
# Anything not in here is stale and gets cleaned up at the end.
$activeMarkers = @{}

foreach ($taskFile in (Get-ChildItem $tasksDir -Filter '*.md' -File -ErrorAction SilentlyContinue)) {
    $content = Get-Content $taskFile.FullName -Raw -Encoding UTF8
    if (-not $content) { continue }

    $idMatch = [regex]::Match($content, '(?m)^id:\s*(\S+)\s*$')
    $statusMatch = [regex]::Match($content, '(?m)^status:\s*(.+?)\s*$')
    if (-not $idMatch.Success -or -not $statusMatch.Success) { continue }

    $taskId = $idMatch.Groups[1].Value.Trim()
    $status = $statusMatch.Groups[1].Value.Trim()
    if ($watchedStatuses -notcontains $status) { continue }

    # Tasks without an `agent:` field are human work -- nothing to restart.
    if (-not [regex]::IsMatch($content, '(?m)^agent:\s*\S')) { continue }

    $checked++

    $safeTaskId = ($taskId -replace '[<>:"/\\|?*\s]+', '_')
    $safeStatus = ($status -replace '[<>:"/\\|?*\s]+', '_')
    $activeMarkers["$safeTaskId-$safeStatus"] = $true

    # dispatch.ps1 names logs "<timestamp>-<dispatcherPid>-<taskId>-<status>.log"
    # and writes the AGENT's pid to "<that>.pid". Newest wins.
    $pidFile = Get-ChildItem $logDir -Filter "*-$safeTaskId-$safeStatus.log.pid" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1

    if (-not $pidFile) {
        # No pid for this status means dispatch never launched an agent -- most
        # often the loop guard fenced it (it writes a .prompt then exits), or the
        # task was moved by hand. Re-firing would just be fenced again, so this
        # needs a human. Report, do not act.
        Write-WD "STALLED  $taskId ($status): no agent was ever launched for this status (loop guard, or a manual status change). Needs a human."
        continue
    }

    # Grace period: a freshly written pid may belong to an agent that is still
    # starting up, and re-firing here would race dispatch.ps1's own dedup.
    $age = (Get-Date) - $pidFile.LastWriteTime
    if ($age.TotalMinutes -lt $GraceMinutes) { continue }

    $agentPid = (Get-Content $pidFile.FullName -Raw -ErrorAction SilentlyContinue)
    if ($agentPid) { $agentPid = ($agentPid -replace '[^\d]', '').Trim() }
    if (-not $agentPid) {
        Write-WD "SKIP     $taskId ($status): pid file '$($pidFile.Name)' is empty or unreadable."
        continue
    }

    # A live process means the agent is still working -- leave it alone. Note a
    # recycled pid can only ever produce a FALSE ALIVE (we skip, harmless), never
    # a false dead (which would double-launch).
    $proc = Get-Process -Id ([int]$agentPid) -ErrorAction SilentlyContinue
    if ($null -ne $proc) { continue }

    # Retry cap, so a provider limit that lasts hours cannot be thrashed against.
    $retryMarker = Join-Path $logDir "$safeTaskId-$safeStatus.watchdog-retries"
    $retries = 0
    if (Test-Path $retryMarker) {
        $raw = (Get-Content $retryMarker -Raw -ErrorAction SilentlyContinue)
        if ($raw) { $retries = [int]($raw -replace '[^\d]', '') }
    }
    if ($retries -ge $MaxRetries) {
        # Log the cap ONCE per hour, not every pass. TASK-587.5 sat capped from
        # 10:15 to 12:20 on 2026-08-18 and produced 13 identical CAPPED lines,
        # burying everything else in the log. The task is still stuck either
        # way -- this only controls how loudly we repeat ourselves.
        $capNoticeFile = "$retryMarker.notified"
        $shouldLog = $true
        try {
            $notice = Get-Item $capNoticeFile -ErrorAction SilentlyContinue
            if ($null -ne $notice -and ((Get-Date) - $notice.LastWriteTime).TotalMinutes -lt 60) { $shouldLog = $false }
        } catch { }
        if ($shouldLog) {
            Write-WD "CAPPED   $taskId ($status): agent pid $agentPid is dead but $retries/$MaxRetries watchdog retries are already used. Needs a human. Reset with: Remove-Item '$retryMarker'"
            (Get-Date).ToString('o') | Set-Content $capNoticeFile -Encoding ASCII -NoNewline -ErrorAction SilentlyContinue
        }
        continue
    }

    $reason = "agent pid $agentPid is gone (log: $($pidFile.Name -replace '\.pid$',''))"
    if ($DryRun) {
        Write-WD "WOULD-FIRE $taskId ($status): $reason [retry $($retries + 1)/$MaxRetries]"
        continue
    }

    # Re-fire the hook with OLD_STATUS = NEW_STATUS = the current status. That
    # signature never occurs on a normal dispatch (which is always a real
    # transition), and it is exactly what dispatch.ps1's $isStrandedRetry looks
    # for on the coder side. On the reviewer side, NEW_STATUS='In Review' plus a
    # recorded reviewer session id is enough for $isReviewerResume; with no
    # recorded session it simply starts a fresh reviewer, which is also correct.
    Write-WD "RESTART  $taskId ($status): $reason [retry $($retries + 1)/$MaxRetries]"
    ($retries + 1).ToString() | Set-Content $retryMarker -Encoding ASCII -NoNewline

    $title = ''
    $titleMatch = [regex]::Match($content, '(?m)^title:\s*(.+?)\s*$')
    if ($titleMatch.Success) { $title = $titleMatch.Groups[1].Value.Trim().Trim('>').Trim() }

    try {
        $env:TASK_ID = $taskId
        $env:OLD_STATUS = $status
        $env:NEW_STATUS = $status
        $env:TASK_TITLE = $title
        & powershell -NoProfile -ExecutionPolicy Bypass -File $dispatchScript 2>&1 |
            ForEach-Object { Write-WD "  dispatch> $_" }
        $acted++
    } catch {
        Write-WD "  FAILED to re-fire dispatch for $taskId : $($_.Exception.Message)"
    } finally {
        Remove-Item Env:\TASK_ID, Env:\OLD_STATUS, Env:\NEW_STATUS, Env:\TASK_TITLE -ErrorAction SilentlyContinue
    }
}

# Clear retry markers for tasks that have since moved on, so a task that gets
# restarted, finishes, and is later dispatched again starts from a clean count.
# Driven by the set collected above -- an earlier version reverse-resolved the
# task id out of the marker filename and got it wrong, deleting the marker of a
# STILL-ACTIVE task on every run. That silently reset the retry counter each
# pass and made -MaxRetries meaningless (verified against a fixture 2026-08-18).
foreach ($marker in (Get-ChildItem $logDir -Filter '*.watchdog-retries' -File -ErrorAction SilentlyContinue)) {
    if (-not $activeMarkers.ContainsKey($marker.BaseName)) {
        Remove-Item $marker.FullName -Force -ErrorAction SilentlyContinue
        Remove-Item "$($marker.FullName).notified" -Force -ErrorAction SilentlyContinue
    }
}

Write-WD "done: $checked task(s) with a live status checked, $acted restarted."
