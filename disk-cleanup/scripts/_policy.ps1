# Shared policy helpers, dot-sourced by every disk-cleanup script.
#
# The never-touch check lives here rather than being copied into each script so
# scan and enforcement cannot drift apart. quarantine.ps1 re-checks every
# candidate through Test-NeverTouch immediately before moving it, regardless of
# what the scan proposed - the scan is a suggestion, this is the gate.

function Read-Policy {
    param([string]$Path = (Join-Path $PSScriptRoot "..\policy.json"))
    if (-not (Test-Path $Path)) { throw "policy.json not found at $Path" }
    Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-NormalizedPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
    try { $p = [System.IO.Path]::GetFullPath($Path) } catch { $p = $Path }
    $p.TrimEnd('\', '/')
}

function Test-NeverTouch {
    <#
      Returns the reason a path is protected, or $null if it is eligible.
      A non-null return must be treated as a hard stop by the caller.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Policy
    )

    $full = Get-NormalizedPath $Path
    if ([string]::IsNullOrWhiteSpace($full)) { return "empty path" }

    # Compare with a trailing separator so "C:\Program Files" cannot match
    # "C:\Program FilesX", and casefold because Windows paths are case-insensitive.
    $probe = ($full + '\').ToLowerInvariant()

    foreach ($prefix in $Policy.never_touch.prefixes) {
        $p = ((Get-NormalizedPath $prefix) + '\').ToLowerInvariant()
        if ($probe.StartsWith($p)) { return "under protected prefix $prefix" }
    }

    foreach ($segment in $Policy.never_touch.path_segments) {
        $s = ('\' + $segment.Trim('\').ToLowerInvariant() + '\')
        if ($probe.Contains($s)) { return "contains protected path segment '$segment'" }
    }

    $leaf = Split-Path $full -Leaf
    foreach ($name in $Policy.never_touch.filenames) {
        if ($leaf.ToLowerInvariant() -eq $name.ToLowerInvariant()) { return "protected system file '$name'" }
    }

    # A quarantine move must stay on one volume. A cross-volume move is a
    # copy-then-delete, which has a window where a failure loses the file.
    if ($full.Length -lt 2 -or $full.Substring(1, 1) -ne ':') { return "not an absolute local path" }

    return $null
}

function Get-DirectorySizeBytes {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { return 0 }
    [int64]$sum
}

function Write-JsonNoBom {
    <#
      ConvertTo-Json defaults to depth 2, which silently truncates nested objects
      into "System.Object[]" strings. Out-File in PS 5.1 adds a UTF-8 BOM, which
      breaks json.load on the Python side. Both are handled here once.
    #>
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $dir = Split-Path $Path -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $json = $Object | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-IsoTimestamp {
    (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
}
