# Deterministic GitLab MR creation for the dispatch pipeline (PowerShell 5.1).
#
# Invoked by dispatch.ps1 when a task transitions to Human Review, so MR
# creation no longer depends on the reviewer agent remembering to do it.
# Idempotent: if an MR already exists for the branch (any state) it does nothing.
# Non-fatal by contract: prints a status line and returns; never throws in a way
# that would block the caller. ASCII-ONLY source (PS 5.1 reads .ps1 as ANSI).
#
# GitLab-specific. To enable it in a consumer project set:
#   GITLAB_PROJECT_ID  - numeric project id (required; script skips if unset)
#   GITLAB_TOKEN       - PAT (else resolved from .mcp.json / ~/.codex/config.toml)
# On a GitHub project this script simply skips (no project id) and the reviewer
# agent's own MR/PR step in review.md remains the path.
#
# FAIL CLOSED: if the implementation branch cannot be resolved *unambiguously*
# and verified to belong to this task, NO MR is created. A skipped MR costs a
# human one minute; a mislabeled MR is a path to merging unreviewed work into
# main. A dotted subtask id like "TASK-587.3" used to collapse to "587" under a
# bare '(\d+)' extraction, so the fallback branch lookup matched every
# feature/task-587-* branch and could pick a sibling subtask's branch instead.
# Fixed by: full decimal id extraction, collecting ALL candidate branches and
# refusing on ambiguity, and verifying the resolved branch's task number before
# any MR is created.
#
# Usage: create-mr.ps1 -TaskId TASK-189 -ProjectRoot <path> [-TaskFile <path>]

param(
    [Parameter(Mandatory = $true)] [string] $TaskId,
    [Parameter(Mandatory = $true)] [string] $ProjectRoot,
    [string] $TaskFile = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot

# GitLab.com requires TLS 1.2; PS 5.1 may default lower.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

function Write-Status([string] $msg) { Write-Host "create-mr.ps1: $msg" }

$projectId = $env:GITLAB_PROJECT_ID
if (-not $projectId) {
    Write-Status "GITLAB_PROJECT_ID not set - skipping MR creation (GitHub project, or configure the env var to enable)"
    return
}
$targetBranch = if ($env:GITLAB_TARGET_BRANCH) { $env:GITLAB_TARGET_BRANCH } else { 'main' }

# -- Resolve the GitLab token --------------------------------------------------
# Order: env GITLAB_TOKEN -> .mcp.json (gitlab server) -> ~/.codex/config.toml.
function Resolve-GitlabToken {
    if ($env:GITLAB_TOKEN) { return $env:GITLAB_TOKEN }

    $mcpPath = Join-Path $ProjectRoot '.mcp.json'
    if (Test-Path $mcpPath) {
        try {
            $json = Get-Content $mcpPath -Raw | ConvertFrom-Json
            $tok = $json.mcpServers.gitlab.env.GITLAB_TOKEN
            if ($tok) { return $tok }
        } catch {}
    }

    $codexCfg = Join-Path $env:USERPROFILE '.codex\config.toml'
    if (Test-Path $codexCfg) {
        $m = Select-String -Path $codexCfg -Pattern 'GITLAB_TOKEN\s*=\s*"([^"]+)"' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) { return $m.Matches[0].Groups[1].Value }
    }
    return ''
}

# -- Task-number variants ------------------------------------------------------
# A decimal id like "587.3" appears in branch names as either "587.3" or, far
# more commonly, "587-3" (feature/task-587-3-android-identity). Build BOTH forms
# and regex-escape them, so the dot is a literal and not a wildcard -- an
# unescaped "587.3" also matches "587x3".
function Get-TaskNumVariants([string] $taskNum) {
    if (-not $taskNum) { return @() }
    $variants = @([regex]::Escape($taskNum))
    if ($taskNum -match '\.') {
        $variants += [regex]::Escape(($taskNum -replace '\.', '-'))
    }
    return ($variants | Select-Object -Unique)
}

# -- Does a branch name belong to this task? -----------------------------------
# Returns 'yes'   - matches this task's number
#         'other' - is a task branch, but for a DIFFERENT task number
#         'unknown' - does not follow the feature/task-N naming convention
function Test-BranchOwnership([string] $branch, [string] $taskNum) {
    $variants = Get-TaskNumVariants $taskNum
    if ($variants.Count -gt 0) {
        $alt = ($variants -join '|')
        # Anchor on a boundary so task-58 does not match task-587.
        if ([regex]::IsMatch($branch, "^feature/(?:task|issue)-(?:$alt)(?:-|$)")) { return 'yes' }
    }
    if ([regex]::IsMatch($branch, '^feature/(?:task|issue)-\d')) { return 'other' }
    return 'unknown'
}

# -- Resolve the implementation branch -----------------------------------------
# Primary source: a "Branch:" line in the task notes (take the LAST one). Never
# use `git branch --show-current` (the shared main worktree HEAD is unreliable).
# Fallback: match origin branches by the FULL task number, collecting every
# candidate so the caller can refuse when there is more than one.
function Resolve-BranchCandidates([string] $taskContent, [string] $taskNum) {
    if ($taskContent) {
        $m = [regex]::Matches($taskContent, '(?im)^\s*Branch:\s*(feature/[A-Za-z0-9._/-]+)\s*$')
        if ($m.Count -gt 0) {
            return @($m[$m.Count - 1].Groups[1].Value.Trim())
        }
    }

    $variants = Get-TaskNumVariants $taskNum
    if ($variants.Count -eq 0) { return @() }
    $alt = ($variants -join '|')

    $found = @()
    $heads = & git -C $ProjectRoot ls-remote --heads origin 2>$null
    if ($heads) {
        $pattern = "refs/heads/(feature/(?:task|issue)-(?:$alt)(?:-[A-Za-z0-9._-]+)?)$"
        foreach ($line in $heads) {
            $mm = [regex]::Match($line, $pattern)
            if ($mm.Success) { $found += $mm.Groups[1].Value }
        }
    }
    return ($found | Select-Object -Unique)
}

# -- Locate the task file ------------------------------------------------------
if (-not $TaskFile -or -not (Test-Path $TaskFile)) {
    $tasksDir = Join-Path $ProjectRoot 'backlog\tasks'
    $found = Get-ChildItem $tasksDir -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ilike "*$TaskId*" } | Select-Object -First 1
    if ($found) { $TaskFile = $found.FullName }
}

# -Encoding UTF8 is REQUIRED: PS 5.1's Get-Content defaults to the system ANSI
# codepage for files with no BOM, and the task .md files are UTF-8 without one.
# Without this a non-ASCII character in a title arrives as mojibake and ships
# into the MR title.
$taskContent = ''
if ($TaskFile -and (Test-Path $TaskFile)) { $taskContent = Get-Content $TaskFile -Raw -Encoding UTF8 }

# Capture the FULL identifier including any decimal suffix: "TASK-587.3" -> "587.3".
# A bare '(\d+)' returns "587" and collides with every sibling subtask.
$taskNum = ''
$nm = [regex]::Match($TaskId, '(\d+(?:\.\d+)*)')
if ($nm.Success) { $taskNum = $nm.Groups[1].Value }

$candidates = @(Resolve-BranchCandidates $taskContent $taskNum)

if ($candidates.Count -eq 0) {
    Write-Status "no implementation branch found for $TaskId - skipping MR (investigation/process task, or branch not recorded)"
    return
}
if ($candidates.Count -gt 1) {
    Write-Status "AMBIGUOUS branch resolution for $TaskId - skipping MR. Candidates: $($candidates -join ', '). Record a 'Branch: feature/...' line in the task notes and re-run."
    return
}

$branch = $candidates[0]

# Verify the branch actually belongs to this task before creating anything.
$ownership = Test-BranchOwnership $branch $taskNum
if ($ownership -eq 'other') {
    Write-Status "REFUSING to create MR: branch '$branch' belongs to a different task, not $TaskId. Fix the branch reference in the task notes."
    return
}
if ($ownership -eq 'unknown') {
    Write-Status "warning: branch '$branch' does not follow feature/task-<num>-* naming; proceeding because it was recorded explicitly for $TaskId"
}

# Verify the branch is actually on origin.
$onOrigin = & git -C $ProjectRoot ls-remote --heads origin $branch 2>$null
if (-not $onOrigin) {
    Write-Status "branch '$branch' not on origin - skipping MR (caller should ensure it is pushed)"
    return
}

$token = Resolve-GitlabToken
if (-not $token) {
    Write-Status "no GitLab token resolved - skipping MR (set GITLAB_TOKEN or .mcp.json gitlab env)"
    return
}

$apiBase = "https://gitlab.com/api/v4/projects/$projectId/merge_requests"
$headers = @{ 'PRIVATE-TOKEN' = $token }

# -- Idempotency: skip if an MR already exists for this source branch ----------
try {
    $enc = [System.Uri]::EscapeDataString($branch)
    $listUri = "$apiBase" + "?source_branch=$enc" + "&state=all"
    $existing = Invoke-RestMethod -Method Get -Headers $headers -Uri $listUri -ErrorAction Stop
    if ($existing -and $existing.Count -gt 0) {
        $iid = $existing[0].iid
        $state = $existing[0].state
        Write-Status "MR already exists for '$branch' (!$iid, $state) - nothing to do"
        return
    }
} catch {
    Write-Status "could not query existing MRs ($($_.Exception.Message)) - attempting create anyway"
}

# -- Cross-check: an open MR already claiming this task, on another branch ------
# The reviewer agent can also open MRs of its own, so both paths can race. If one
# already claims this task from a different branch, something is wrong -- refuse
# rather than adding a second, contradictory MR.
try {
    $openUri = "$apiBase" + "?state=opened&per_page=100"
    $open = Invoke-RestMethod -Method Get -Headers $headers -Uri $openUri -ErrorAction Stop
    foreach ($mr in $open) {
        $claims = ($mr.description -and $mr.description -match [regex]::Escape("Closes $TaskId")) -or
                  ($mr.title -and $mr.title -match [regex]::Escape("($TaskId)"))
        if ($claims -and $mr.source_branch -ne $branch) {
            Write-Status "REFUSING to create MR: !$($mr.iid) already claims $TaskId from branch '$($mr.source_branch)' (this run resolved '$branch'). Resolve the conflict by hand."
            return
        }
    }
} catch {
    Write-Status "could not cross-check open MRs ($($_.Exception.Message)) - continuing"
}

# -- Resolve a title from frontmatter (single-line or folded block scalar) -----
function Resolve-Title([string] $content, [string] $taskId) {
    if ($content) {
        $lines = $content -split "`r?`n"
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match '^title:\s*(.*)$') {
                $val = $matches[1].Trim()
                if ($val -eq '>-' -or $val -eq '>' -or $val -eq '|' -or $val -eq '|-' -or $val -eq '') {
                    # Folded/block scalar: gather following indented lines.
                    $parts = @()
                    for ($j = $i + 1; $j -lt $lines.Count; $j++) {
                        if ($lines[$j] -match '^\s+\S') { $parts += $lines[$j].Trim() } else { break }
                    }
                    if ($parts.Count -gt 0) { return ($parts -join ' ') }
                } else {
                    return ($val.Trim("'").Trim('"'))
                }
            }
        }
    }
    return "$taskId changes"
}

$title = Resolve-Title $taskContent $TaskId
$mrTitle = "$title ($TaskId)"
$mrDescription = "Automated MR opened by the dispatch hook when $TaskId reached Human Review.`n`nCloses $TaskId"

$body = @{
    source_branch = $branch
    target_branch = $targetBranch
    title         = $mrTitle
    description   = $mrDescription
    remove_source_branch = $false
} | ConvertTo-Json

# Send explicit UTF-8 bytes. Handing PS 5.1 a [string] body lets it re-encode
# with the ANSI codepage regardless of the declared charset, which is the other
# half of the mojibake in the title.
$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)

try {
    $created = Invoke-RestMethod -Method Post -Headers $headers -Uri $apiBase -ContentType 'application/json; charset=utf-8' -Body $bodyBytes -ErrorAction Stop
    Write-Status "created MR !$($created.iid) for '$branch' -> $targetBranch ($($created.web_url))"
} catch {
    Write-Status "MR create failed for '$branch': $($_.Exception.Message)"
}
