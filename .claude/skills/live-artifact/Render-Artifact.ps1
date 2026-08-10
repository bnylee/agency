# Render a bot run's facts file into a self-contained HTML page.
#
# One line at the end of a bot's run script:
#
#   & "$agencyRoot\.claude\skills\live-artifact\Render-Artifact.ps1" `
#       -Facts (Join-Path $botDir "runs\$today.artifact.json") `
#       -Out   (Join-Path $botDir "runs\$today.html") `
#       -Log   $logFile -DryRun:$DryRun
#
# ## Why this is called by the SCRIPT and not by the agent
#
# Every bot here splits the work the same way: the agent writes prose and JSON,
# the script does anything deterministic. Rendering is deterministic, so it
# belongs on this side of the line, and putting it here buys three things:
#
#   - finance-research and sam-research have NO shell permission at all. Their
#     agents could not invoke a renderer if they wanted to.
#   - disk-cleanup and agency-repair have PreToolUse command guards that
#     allowlist only their own scripts and additionally refuse any path under
#     OneDrive outside their own tree. The shared renderer is both. Calling it
#     from the run script means neither guard has to be loosened, and loosening
#     either of those to make a nicer HTML page would be a bad trade.
#   - It costs zero model tokens to invoke.
#
# ## It never fails the run
#
# A missing facts file is the normal state of a run that died early, and a
# cosmetic page is not worth converting a partial run into a failed one. So this
# logs and returns rather than throwing. The caller stays in charge of what
# counts as failure; note that means the caller must not treat a missing HTML
# file as proof the run broke.
param(
    [Parameter(Mandatory = $true)][string]$Facts,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Log,
    [switch]$DryRun
)

$stamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"

function Write-Line([string]$text) {
    $line = "[$stamp] live-artifact: $text"
    if ($Log) { Add-Content -Path $Log -Value $line }
    Write-Host $line
}

$renderer = Join-Path $PSScriptRoot "render.mjs"

if (-not (Test-Path $renderer)) {
    Write-Line "renderer missing at $renderer - skipped"
    return
}
if (-not (Test-Path $Facts)) {
    Write-Line "no facts file at $Facts - skipped (normal when a run ended early)"
    return
}

# node is resolved through PATH deliberately. Hardcoding a version-specific path
# is the kind of thing that breaks silently on the next Node upgrade, and there
# is nothing here that needs a particular version - this is one file read and one
# file write against the standard library.
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    Write-Line "node is not on PATH - skipped. Install Node or remove this step."
    return
}

$argv = @("--in", $Facts, "--out", $Out)
if ($DryRun) { $argv += "--dry-run" }

# stderr is NOT merged with 2>&1. In PowerShell 5.1 that wraps every stderr line
# from a native command in an ErrorRecord, which under
# $ErrorActionPreference = "Stop" is terminating - and the caller's script very
# likely has that set. The renderer writes its validation errors to stderr, so
# merging them here would turn a typo in a facts file into a dead run. Same
# lesson as the claude.exe invocation in run_premarket.ps1.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $output = & $node.Source $renderer @argv
    $exit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $prevEap
}

foreach ($line in @($output)) { if ($line) { Write-Line $line } }

if ($exit -ne 0) {
    Write-Line "renderer exited $exit - the run report stands on its own, the page does not exist"
} elseif (-not $DryRun) {
    Write-Line "wrote $Out"
}
