<#
  Tier A - read-only, and permanently report-only.

  This is the highest-value scanner on this machine: installed games alone are
  roughly 58% of used space, several times larger than every junk-file category
  combined. It reads sizes and last-used dates and ranks them. It never
  uninstalls anything - "do I still play this?" is a human judgement no
  heuristic should make, and guard_commands.py blocks uninstall verbs outright.

  Writes state/installed-latest.json.
#>
[CmdletBinding()]
param(
    [string]$Out,
    [int]$ColdDays = 90
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot is EMPTY inside param() defaults when [CmdletBinding()] is
# present, so every script-relative path is resolved here in the body instead.
# As a param default this silently produced a Join-Path binding error on every
# run.
if (-not $Out) { $Out = Join-Path $PSScriptRoot "..\state\installed-latest.json" }

. (Join-Path $PSScriptRoot "_policy.ps1")

$entries = New-Object System.Collections.ArrayList
$notes = New-Object System.Collections.ArrayList
$epoch = Get-Date "1970-01-01Z"

# A launcher-managed game also appears in the registry's Uninstall keys, so
# without this the same install is counted twice and the total is inflated
# (League of Legends and VALORANT did exactly that: ~68 GB of phantom space).
# Launchers are scanned first and win, because they carry better metadata.
$seenNames = New-Object System.Collections.Generic.HashSet[string]
$seenLocations = New-Object System.Collections.Generic.HashSet[string]

function Add-Entry {
    param(
        [string]$Name, [string]$Source, [int64]$Bytes,
        [nullable[datetime]]$LastUsed, [string]$Location, [string]$UninstallHint
    )
    $age = if ($LastUsed) { [int]((Get-Date) - $LastUsed).TotalDays } else { $null }

    [void]$seenNames.Add($Name.Trim().ToLowerInvariant())
    if ($Location) { [void]$seenLocations.Add((Get-NormalizedPath $Location).ToLowerInvariant()) }

    # PSCustomObject, not a bare hashtable: Measure-Object -Property and
    # Sort-Object -Property do not see hashtable keys as properties in PS 5.1.
    [void]$entries.Add([pscustomobject][ordered]@{
        name           = $Name
        source         = $Source
        gb             = [math]::Round($Bytes / 1GB, 2)
        bytes          = $Bytes
        last_used      = if ($LastUsed) { $LastUsed.ToString("yyyy-MM-dd") } else { $null }
        days_since_use = $age
        cold           = if ($null -ne $age) { $age -ge $ColdDays } else { $null }
        location       = $Location
        uninstall_hint = $UninstallHint
    })
}

# ------------------------------------------------------------------ Steam
# appmanifest_<appid>.acf files carry SizeOnDisk and LastPlayed directly, which
# makes Steam the one launcher that gives an exact, trustworthy last-used date.
$steamRoots = New-Object System.Collections.ArrayList
$steamBase = "C:\Program Files (x86)\Steam"
if (Test-Path "$steamBase\steamapps") { [void]$steamRoots.Add("$steamBase\steamapps") }

$libraryVdf = "$steamBase\steamapps\libraryfolders.vdf"
if (Test-Path $libraryVdf) {
    foreach ($m in [regex]::Matches((Get-Content $libraryVdf -Raw), '"path"\s+"([^"]+)"')) {
        $lib = Join-Path ($m.Groups[1].Value -replace '\\\\', '\') "steamapps"
        if ((Test-Path $lib) -and ($steamRoots -notcontains $lib)) { [void]$steamRoots.Add($lib) }
    }
}

foreach ($root in $steamRoots) {
    foreach ($acf in Get-ChildItem -LiteralPath $root -Filter "appmanifest_*.acf" -File -ErrorAction SilentlyContinue) {
        $t = Get-Content -LiteralPath $acf.FullName -Raw
        $name = if ($t -match '"name"\s+"([^"]+)"') { $matches[1] } else { $acf.BaseName }
        $size = if ($t -match '"SizeOnDisk"\s+"(\d+)"') { [int64]$matches[1] } else { 0 }
        $lp = if ($t -match '"LastPlayed"\s+"(\d+)"') { [int64]$matches[1] } else { 0 }
        $dir = if ($t -match '"installdir"\s+"([^"]+)"') { Join-Path $root (Join-Path "common" $matches[1]) } else { $root }
        $last = if ($lp -gt 0) { $epoch.AddSeconds($lp).ToLocalTime() } else { $null }
        Add-Entry -Name $name -Source "Steam" -Bytes $size -LastUsed $last -Location $dir `
            -UninstallHint "Steam > Library > right-click '$name' > Manage > Uninstall"
    }
}

# ------------------------------------------------------------------ Epic
$epicManifests = "C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests"
if (Test-Path $epicManifests) {
    foreach ($item in Get-ChildItem -LiteralPath $epicManifests -Filter "*.item" -File -ErrorAction SilentlyContinue) {
        try { $m = Get-Content -LiteralPath $item.FullName -Raw | ConvertFrom-Json } catch { continue }
        $loc = $m.InstallLocation
        $bytes = if ($m.InstallSize) { [int64]$m.InstallSize } elseif ($loc) { Get-DirectorySizeBytes $loc } else { 0 }
        # Epic manifests carry no last-played field; fall back to the install
        # directory's mtime, which is a weaker proxy. Flagged in notes below.
        $last = if ($loc -and (Test-Path $loc)) { (Get-Item -LiteralPath $loc).LastWriteTime } else { $null }
        Add-Entry -Name $m.DisplayName -Source "Epic" -Bytes $bytes -LastUsed $last -Location $loc `
            -UninstallHint "Epic Games Launcher > Library > '$($m.DisplayName)' > Uninstall"
    }
    [void]$notes.Add("Epic manifests carry no last-played timestamp. days_since_use for Epic titles is derived from install-directory mtime, which reflects patching as much as play - treat it as far weaker evidence than Steam's LastPlayed.")
}

# ------------------------------------------------------------------ Riot
if (Test-Path "C:\Riot Games") {
    foreach ($d in Get-ChildItem "C:\Riot Games" -Directory -Force -ErrorAction SilentlyContinue) {
        Add-Entry -Name $d.Name -Source "Riot" -Bytes (Get-DirectorySizeBytes $d.FullName) `
            -LastUsed $d.LastWriteTime -Location $d.FullName `
            -UninstallHint "Riot Client > Settings > Uninstall, or Windows Settings > Apps"
    }
    [void]$notes.Add("Riot installs expose no usage metadata; last_used is directory mtime only.")
}

# ------------------------------------------------------------------ registry apps
$uninstallKeys = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
$seenApps = New-Object System.Collections.Generic.HashSet[string]
$dedupedCount = 0
foreach ($key in $uninstallKeys) {
    foreach ($app in Get-ItemProperty $key -ErrorAction SilentlyContinue) {
        if (-not $app.DisplayName) { continue }
        if (-not $app.EstimatedSize) { continue }
        if ($app.SystemComponent -eq 1) { continue }
        if (-not $seenApps.Add($app.DisplayName)) { continue }

        # Already recorded by a launcher above, which has better metadata.
        if ($seenNames.Contains($app.DisplayName.Trim().ToLowerInvariant())) { $dedupedCount++; continue }
        if ($app.InstallLocation -and $seenLocations.Contains((Get-NormalizedPath $app.InstallLocation).ToLowerInvariant())) { $dedupedCount++; continue }
        $bytes = [int64]$app.EstimatedSize * 1024      # EstimatedSize is in KB
        if ($bytes -lt 500MB) { continue }             # keep the report readable
        $installed = $null
        if ($app.InstallDate -and $app.InstallDate -match '^\d{8}$') {
            try { $installed = [datetime]::ParseExact($app.InstallDate, "yyyyMMdd", $null) } catch {}
        }
        Add-Entry -Name $app.DisplayName -Source "Installed app" -Bytes $bytes -LastUsed $installed `
            -Location $app.InstallLocation -UninstallHint "Windows Settings > Apps > Installed apps"
    }
}
[void]$notes.Add("For registry-listed apps, last_used is the INSTALL date, not a usage date - Windows does not record last-run reliably. Do not read a cold flag on these as 'unused'.")

# ------------------------------------------------------------------ summary
$sorted = @($entries | Sort-Object { $_.bytes } -Descending)
$totalBytes = ($entries | Measure-Object -Property bytes -Sum).Sum
if ($null -eq $totalBytes) { $totalBytes = 0 }

$coldGames = @($sorted | Where-Object { $_.cold -eq $true -and $_.source -eq "Steam" })
$coldBytes = ($coldGames | Measure-Object -Property bytes -Sum).Sum
if ($null -eq $coldBytes) { $coldBytes = 0 }

$result = [ordered]@{
    generated_at        = Get-IsoTimestamp
    status              = "ok"
    disposition         = "REPORT ONLY - this bot never uninstalls anything, at any tier."
    cold_threshold_days = $ColdDays
    deduped_registry_entries = $dedupedCount
    entry_count         = $entries.Count
    total_gb            = [math]::Round($totalBytes / 1GB, 2)
    cold_steam_count    = $coldGames.Count
    cold_steam_gb       = [math]::Round($coldBytes / 1GB, 2)
    entries             = $sorted
    notes               = @($notes)
}

Write-JsonNoBom -Object $result -Path $Out
Write-Output "scan_installed: $($entries.Count) programs, $([math]::Round($totalBytes/1GB,2)) GB total, $([math]::Round($coldBytes/1GB,2)) GB in cold Steam titles -> $Out"
