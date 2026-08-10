# agency-repair health check.
#
#   .\health_check.ps1                     every probe, JSON to stdout
#   .\health_check.ps1 -Out state\h.json   also write it to a file
#   .\health_check.ps1 -Only dashboard:typecheck    one probe
#
# Pure PowerShell. No agent, no tokens. That is the point: this script decides
# whether the Agency is broken, and only a failure is worth spending an agent
# on. The decision about whether to spend tokens cannot be made by the thing
# that spends them.
#
# It is also the ONLY surface through which agency-repair may run a compiler.
# Its command guard allowlists this script by name and denies everything else,
# and settings.json denies Edit(./scripts/**) so the bot cannot widen it. A bot
# that can edit the health check can make every probe pass.
#
# Each probe returns pass | fail | skip. A skip is a probe that could not run
# (a missing toolchain), and is never counted as a pass -- "we did not look" and
# "we looked and it was fine" are different facts.
param(
    [string]$Only,
    [string]$Out,
    [switch]$Quiet
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

$botRoot = Split-Path -Parent $PSScriptRoot
$agency = Split-Path -Parent $botRoot
$dash = Join-Path $agency "dashboard"

# Hardcoded, not discovered. A directory scan would make a new folder on disk a
# new set of expectations, and the mapping from bot to scheduled task has to be
# stated somewhere rather than guessed.
$bots = @(
    @{ id = "sam-research";     task = "sam-research-weekly";        maxAgeDays = 9 }
    @{ id = "finance-research"; task = "finance-research-premarket"; maxAgeDays = 5 }
    @{ id = "disk-cleanup";     task = "disk-cleanup-weekly";        maxAgeDays = 9 }
    @{ id = "interface-design"; task = $null;                        maxAgeDays = $null }
    @{ id = "agency-repair";    task = "agency-repair-daily";        maxAgeDays = 3 }
)

$probes = New-Object System.Collections.ArrayList

function Add-Probe {
    param([string]$Name, [string]$Status, [string]$Detail, $Evidence = $null)
    $null = $probes.Add([pscustomobject]@{
            name     = $Name
            status   = $Status
            detail   = $Detail
            evidence = if ($Evidence) { ($Evidence | Out-String).Trim() } else { $null }
        })
}

function Test-Wanted([string]$Name) {
    return (-not $Only) -or ($Only -eq $Name)
}

# Truncated hard. A probe's evidence is a lead for the agent, not a transcript;
# a 4,000-line vite log in the report costs tokens and says nothing extra.
function Limit-Text($Text, [int]$Max = 2500) {
    $s = ($Text | Out-String)
    if ($s.Length -le $Max) { return $s.Trim() }
    return $s.Substring(0, $Max).Trim() + "`n... [truncated]"
}

function Get-BotFiles([string]$BotId, [string]$Sub, [string]$Filter) {
    $dir = Join-Path (Join-Path $agency $BotId) $Sub
    if (-not (Test-Path $dir)) { return @() }
    return Get-ChildItem -Path $dir -Filter $Filter -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\(node_modules|\.venv|dist)\\' }
}

# Starts the control-plane API as a child process. Used by both dashboard
# probes, which is the point: this began life inside api-port-conflict, the
# api-boot probe above kept its own Start-Process/tsx.cmd version, and the two
# defects fixed here were left uncorrected there for a full day. One
# implementation cannot drift from itself.
#
# node against tsx's CLI entry, NOT node_modules\.bin\tsx.cmd. Both reasons were
# found by running this rather than reading it:
#
#   1. Start-Process -PassThru WITH redirection hands back a Process whose
#      ExitCode is silently empty -- not an error, just blank. That makes any
#      "exited non-zero" assertion dead code, because $null -eq 0 is false.
#   2. The .cmd is a cmd.exe shim. Start-Process returns the SHIM, while the
#      node child underneath it is what calls listen() and holds the port.
#      Stop-Process on the shim does not touch that child, so every run of the
#      old api-boot probe orphaned one node process that held its port until
#      reboot.
#
# Starting node directly gives a real exit code and one process to kill.
function Start-ApiInstance {
    param([string]$Cli, [string]$WorkDir)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "node"
    $psi.Arguments = "`"$Cli`" server/index.ts"
    $psi.WorkingDirectory = $WorkDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    return [System.Diagnostics.Process]::Start($psi)
}

# Kills a process started by Start-ApiInstance, and anything it spawned. /T
# because a clean node has no children but a wedged one may, and a probe that
# leaves a process holding a port poisons every later run on that port.
function Stop-ApiInstance($Proc) {
    if (-not $Proc) { return }
    try { if ($Proc.HasExited) { return } } catch { return }
    Start-Process -FilePath "taskkill" -ArgumentList "/T", "/F", "/PID", "$($Proc.Id)" `
        -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
}

# ------------------------------------------------------- dashboard:typecheck
if (Test-Wanted "dashboard:typecheck") {
    $tsc = Join-Path $dash "node_modules\typescript\bin\tsc"
    if (-not (Test-Path $tsc)) {
        Add-Probe "dashboard:typecheck" "skip" "typescript is not installed in dashboard/node_modules"
    } else {
        Push-Location $dash
        $o = & node $tsc --noEmit -p (Join-Path $dash "tsconfig.json") 2>&1
        $code = $LASTEXITCODE
        Pop-Location
        if ($code -eq 0) {
            Add-Probe "dashboard:typecheck" "pass" "tsc --noEmit clean"
        } else {
            Add-Probe "dashboard:typecheck" "fail" "tsc --noEmit exited $code" (Limit-Text $o)
        }
    }
}

# ----------------------------------------------------------- dashboard:build
if (Test-Wanted "dashboard:build") {
    $vite = Join-Path $dash "node_modules\vite\bin\vite.js"
    if (-not (Test-Path $vite)) {
        Add-Probe "dashboard:build" "skip" "vite is not installed in dashboard/node_modules"
    } else {
        Push-Location $dash
        $o = & node $vite build --logLevel warn 2>&1
        $code = $LASTEXITCODE
        Pop-Location
        if ($code -eq 0) {
            Add-Probe "dashboard:build" "pass" "vite build succeeded"
        } else {
            Add-Probe "dashboard:build" "fail" "vite build exited $code" (Limit-Text $o)
        }
    }
}

# -------------------------------------------------------- dashboard:api-boot
# The only probe that runs the product rather than inspecting it. A typecheck
# says the code compiles; this says the server actually answers. They fail
# independently, which is the reason for having both.
if (Test-Wanted "dashboard:api-boot") {
    $tsxCli = Join-Path $dash "node_modules\tsx\dist\cli.mjs"
    if (-not (Test-Path $tsxCli)) {
        Add-Probe "dashboard:api-boot" "skip" "tsx is not installed in dashboard/node_modules"
    } else {
        # A throwaway token on a throwaway port, inherited by the child from this
        # process. The real .env is never read: dotenv does not override
        # variables already present in the child's environment, so these win, and
        # the live server on 7777 is untouched.
        $token = [guid]::NewGuid().ToString("N")
        $port = Get-Random -Minimum 21000 -Maximum 21999
        $proc = $null
        $ok = $false; $detail = "no response"; $evidence = $null

        $env:AGENCY_TOKEN = $token; $env:AGENCY_PORT = "$port"; $env:AGENCY_HOST = "127.0.0.1"
        try {
            $proc = Start-ApiInstance -Cli $tsxCli -WorkDir $dash
            # Drain the pipes so a full buffer can never stall the server. The
            # tasks are awaited below only if the probe fails and wants evidence.
            $outTask = $proc.StandardOutput.ReadToEndAsync()
            $errTask = $proc.StandardError.ReadToEndAsync()

            foreach ($attempt in 1..20) {
                Start-Sleep -Milliseconds 500
                if ($proc.HasExited) { $detail = "server exited early with code $($proc.ExitCode)"; break }
                try {
                    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/bots" `
                        -Headers @{ "x-agency-token" = $token } -UseBasicParsing -TimeoutSec 4
                    if ($r.StatusCode -eq 200) {
                        $body = $r.Content | ConvertFrom-Json
                        $ok = $true
                        $detail = "GET /api/bots -> 200, $($body.bots.Count) bots"
                        break
                    }
                } catch { $detail = $_.Exception.Message }
            }

            # An unauthenticated request must be refused. A server that answers
            # without the header is a worse bug than one that does not answer.
            if ($ok) {
                try {
                    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/bots" -UseBasicParsing -TimeoutSec 4
                    $ok = $false
                    $detail = "SECURITY: /api/bots answered without a token"
                } catch {
                    if ("$($_.Exception.Response.StatusCode.value__)" -ne "401") {
                        $detail += "; unauthenticated request refused with $($_.Exception.Response.StatusCode.value__), expected 401"
                    } else {
                        $detail += "; unauthenticated request correctly 401"
                    }
                }
            }

            if (-not $ok) {
                # Bounded waits, not bare .Result: if the server is still alive
                # its pipes never close, and .Result would block this script for
                # ever collecting evidence about a process it is about to kill.
                $stderrText = ""
                if ($errTask.Wait(2000)) { $stderrText = $errTask.Result }
                if (-not $stderrText -and $outTask.Wait(2000)) { $stderrText = $outTask.Result }
                if ($stderrText) { $evidence = Limit-Text $stderrText }
            }
        } finally {
            # Always, and via taskkill /T. The previous version stopped a
            # cmd.exe shim and orphaned the node child holding the port, so
            # every run of this probe leaked one process.
            Stop-ApiInstance $proc
            $env:AGENCY_TOKEN = $null; $env:AGENCY_PORT = $null; $env:AGENCY_HOST = $null
        }

        Add-Probe "dashboard:api-boot" $(if ($ok) { "pass" } else { "fail" }) $detail $evidence
    }
}

# ------------------------------------------- dashboard:api-port-conflict
# Starting the control plane twice is the likeliest way a human meets this
# codebase failing: `npm run dev` in a second terminal, or after the first one
# was left running. vite says "Port 5173 is already in use" and stops, which is
# legible. The API let the EADDRINUSE escape as an unhandled 'error' event, so
# the terminal filled with a Node crash banner and a stack through node:net --
# and the one fact the user needed, that it was already running, appeared
# nowhere. That is a real failure of the product even though every other probe
# passes, which is why this probe exists at all.
#
# It holds a port with one instance and starts a second on the same port,
# asserting the second exits deliberately, names the conflict, and does not
# die on an unhandled 'error' event.
if (Test-Wanted "dashboard:api-port-conflict") {
    # Uses the shared Start-ApiInstance / Stop-ApiInstance helpers defined at the
    # top of this script. Both the "node, not tsx.cmd" reasoning and the taskkill
    # /T cleanup live in the comment there.
    $tsxCli = Join-Path $dash "node_modules\tsx\dist\cli.mjs"
    if (-not (Test-Path $tsxCli)) {
        Add-Probe "dashboard:api-port-conflict" "skip" "tsx is not installed in dashboard/node_modules"
    } else {
        $token = [guid]::NewGuid().ToString("N")
        $port = Get-Random -Minimum 21000 -Maximum 21999
        $procA = $null; $procB = $null
        $ok = $false; $detail = "did not run"; $evidence = $null

        # Both instances inherit the same throwaway port and token from this
        # process. The real .env is never read: dotenv does not override
        # variables already present in the child's environment, so these win and
        # the live server on 7777 is untouched.
        $env:AGENCY_TOKEN = $token; $env:AGENCY_PORT = "$port"; $env:AGENCY_HOST = "127.0.0.1"
        try {
            $procA = Start-ApiInstance -Cli $tsxCli -WorkDir $dash
            # Drain A's pipes so a full buffer can never stall the holder. The
            # results are never read; starting the reads is the whole point.
            $null = $procA.StandardOutput.ReadToEndAsync()
            $null = $procA.StandardError.ReadToEndAsync()

            # The first instance must actually own the port before the second
            # starts, or the second binds cleanly and the probe tests nothing.
            $held = $false
            foreach ($attempt in 1..20) {
                Start-Sleep -Milliseconds 500
                if ($procA.HasExited) { break }
                try {
                    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/bots" `
                        -Headers @{ "x-agency-token" = $token } -UseBasicParsing -TimeoutSec 4
                    if ($r.StatusCode -eq 200) { $held = $true; break }
                } catch { }
            }

            if (-not $held) {
                $detail = "could not get a first instance holding port $port, so the conflict was never provoked"
            } else {
                $procB = Start-ApiInstance -Cli $tsxCli -WorkDir $dash
                $outB = $procB.StandardOutput.ReadToEndAsync()
                $errB = $procB.StandardError.ReadToEndAsync()

                # A deliberate exit is prompt. 20s covers node plus tsx start-up
                # and a failed bind; past that the process is hung, not failing.
                $exited = $procB.WaitForExit(20000)
                if (-not $exited) { Stop-ApiInstance $procB }

                # NOT $out: PowerShell variable names are case-insensitive, so
                # $out IS the -Out parameter, and assigning the log to it made
                # the script try to write its JSON to a path named
                # "node:events:487...". Probe-local names carry a prefix here.
                #
                # Bounded waits, not bare .Result: if anything still holds the
                # write end of a pipe, .Result never returns and the health
                # check hangs instead of reporting.
                $conflictLog = ""
                foreach ($t in @($outB, $errB)) {
                    if ($t.Wait(5000)) { $conflictLog += $t.Result }
                }

                if (-not $exited) {
                    $detail = "second instance did not exit within 20s; a taken port must fail, not hang"
                } elseif ($conflictLog -match "Unhandled 'error' event" -or $conflictLog -match "throw er;") {
                    $detail = "second instance died on an unhandled 'error' event instead of reporting the conflict"
                } elseif ($conflictLog -notmatch "already in use") {
                    $detail = "second instance exited $($procB.ExitCode) without saying the port was already in use"
                } elseif ($procB.ExitCode -eq 0) {
                    $detail = "second instance reported the conflict but exited 0; a failed bind is not success"
                } else {
                    $ok = $true
                    $detail = "second instance on a taken port exited $($procB.ExitCode) naming the conflict, no unhandled 'error' event"
                }
                if (-not $ok) { $evidence = Limit-Text $conflictLog }
            }
        } catch {
            $detail = "probe error: $($_.Exception.Message)"
        } finally {
            # B before A: killing the holder first would free the port and let a
            # still-retrying B bind it, turning a leaked process into a leaked
            # listening process.
            Stop-ApiInstance $procB
            Stop-ApiInstance $procA
            $env:AGENCY_TOKEN = $null; $env:AGENCY_PORT = $null; $env:AGENCY_HOST = $null
        }

        Add-Probe "dashboard:api-port-conflict" $(if ($ok) { "pass" } else { "fail" }) $detail $evidence
    }
}

# ------------------------------------------------------------- bots:json
if (Test-Wanted "bots:json") {
    $bad = @()
    $count = 0
    foreach ($b in $bots) {
        foreach ($sub in @("state", ".claude")) {
            foreach ($f in (Get-BotFiles $b.id $sub "*.json")) {
                $count++
                try { $null = Get-Content $f.FullName -Raw | ConvertFrom-Json }
                catch { $bad += "$($f.FullName): $($_.Exception.Message)" }
            }
        }
    }
    if ($bad.Count -eq 0) {
        Add-Probe "bots:json" "pass" "$count JSON files parse"
    } else {
        Add-Probe "bots:json" "fail" "$($bad.Count) of $count JSON files do not parse" ($bad -join "`n")
    }
}

# --------------------------------------------------------- bots:ps-parse
if (Test-Wanted "bots:ps-parse") {
    $bad = @(); $count = 0
    foreach ($b in $bots) {
        foreach ($f in (Get-BotFiles $b.id "scripts" "*.ps1")) {
            $count++
            $errs = $null
            $null = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)
            if ($errs) { $bad += "$($f.FullName): $($errs[0].Message) (line $($errs[0].Extent.StartLineNumber))" }
        }
    }
    if ($bad.Count -eq 0) {
        Add-Probe "bots:ps-parse" "pass" "$count PowerShell scripts parse"
    } else {
        Add-Probe "bots:ps-parse" "fail" "$($bad.Count) of $count scripts do not parse" ($bad -join "`n")
    }
}

# -------------------------------------------------------- bots:py-compile
if (Test-Wanted "bots:py-compile") {
    $py = (Get-Command python -ErrorAction SilentlyContinue)
    if (-not $py) {
        Add-Probe "bots:py-compile" "skip" "python is not on PATH"
    } else {
        $bad = @(); $count = 0
        foreach ($b in $bots) {
            foreach ($sub in @("scripts", ".claude\hooks")) {
                foreach ($f in (Get-BotFiles $b.id $sub "*.py")) {
                    $count++
                    $o = & python -m py_compile $f.FullName 2>&1
                    if ($LASTEXITCODE -ne 0) { $bad += "$($f.FullName): $(Limit-Text $o 400)" }
                }
            }
        }
        if ($bad.Count -eq 0) {
            Add-Probe "bots:py-compile" "pass" "$count Python files compile"
        } else {
            Add-Probe "bots:py-compile" "fail" "$($bad.Count) of $count Python files do not compile" ($bad -join "`n")
        }
    }
}

# ----------------------------------------------------- bots:guard-behaviour
# The probe that matters most. Every other check asks whether the code runs;
# this one asks whether the safety rail still stops anything. A guard that has
# been quietly broken looks exactly like a guard that works.
if (Test-Wanted "bots:guard-behaviour") {
    $py = (Get-Command python -ErrorAction SilentlyContinue)
    if (-not $py) {
        Add-Probe "bots:guard-behaviour" "skip" "python is not on PATH"
    } else {
        # Stdin comes from a file rather than a pipeline. PowerShell 5.1 encodes
        # a pipeline into a native command using $OutputEncoding, which emits a
        # UTF-8 BOM, and python's json.load then dies with "Unexpected UTF-8 BOM"
        # before the hook runs a single line -- making every guard in the Agency
        # look broken. Setting $OutputEncoding does not fix it from inside a
        # script, because the assignment is script-scoped. A file written with an
        # explicit BOM-less encoding takes the preference variable out of the
        # question entirely. Real Claude Code hooks never see a BOM, so this was
        # the probe's bug, not the guards'.
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $inFile = Join-Path $env:TEMP "agency-repair-guardprobe-in.json"
        $outFile = Join-Path $env:TEMP "agency-repair-guardprobe-out.txt"

        function Invoke-Guard($HookPath, $PayloadJson) {
            [System.IO.File]::WriteAllText($inFile, $PayloadJson, $utf8)
            $p = Start-Process -FilePath "python" -ArgumentList "`"$HookPath`"" `
                -RedirectStandardInput $inFile -RedirectStandardOutput $outFile `
                -RedirectStandardError "$outFile.err" -NoNewWindow -Wait -PassThru
            $text = ""
            if (Test-Path $outFile) { $text = Get-Content $outFile -Raw }
            if (-not $text -and (Test-Path "$outFile.err")) { $text = Get-Content "$outFile.err" -Raw }
            return @{ text = "$text"; code = $p.ExitCode }
        }

        $bad = @(); $tested = 0
        foreach ($b in $bots) {
            $hook = Join-Path $agency "$($b.id)\.claude\hooks\guard_writes.py"
            if (-not (Test-Path $hook)) {
                if ($b.id -ne "interface-design") { $bad += "$($b.id): no guard_writes.py" }
                continue
            }
            $tested++
            # Must DENY a write to a system path.
            $payload = @{ tool_name = "Write"; tool_input = @{ file_path = "C:\Windows\System32\drivers\etc\hosts" } } | ConvertTo-Json -Compress
            $r1 = Invoke-Guard $hook $payload
            if ($r1.text -notmatch '"permissionDecision"\s*:\s*"deny"') {
                $bad += "$($b.id): guard did NOT deny a write to C:\Windows\System32 (returned: $(Limit-Text $r1.text 300))"
            }
            # Must ALLOW a write to its own runs/.
            $own = Join-Path $agency "$($b.id)\runs\probe.md"
            $payload2 = @{ tool_name = "Write"; tool_input = @{ file_path = $own } } | ConvertTo-Json -Compress
            $r2 = Invoke-Guard $hook $payload2
            if ($r2.text -match '"permissionDecision"\s*:\s*"deny"') {
                $bad += "$($b.id): guard denied a write to its OWN runs/ (returned: $(Limit-Text $r2.text 300))"
            }
        }
        Remove-Item $inFile, $outFile, "$outFile.err" -Force -ErrorAction SilentlyContinue

        if ($bad.Count -eq 0) {
            Add-Probe "bots:guard-behaviour" "pass" "$tested write guards deny outside and permit inside"
        } else {
            Add-Probe "bots:guard-behaviour" "fail" "$($bad.Count) guard failures across $tested bots" ($bad -join "`n")
        }
    }
}

# ------------------------------------------------------ bots:settings-shape
if (Test-Wanted "bots:settings-shape") {
    $bad = @(); $checked = 0
    foreach ($b in $bots) {
        $dir = Join-Path $agency "$($b.id)\.claude"
        $shared = Join-Path $dir "settings.json"
        $local = Join-Path $dir "settings.local.json"
        if (-not (Test-Path $shared)) { $bad += "$($b.id): no .claude/settings.json"; continue }
        if (-not (Test-Path $local)) { $bad += "$($b.id): no .claude/settings.local.json"; continue }
        $checked++
        try {
            $s = Get-Content $shared -Raw | ConvertFrom-Json
            $l = Get-Content $local -Raw | ConvertFrom-Json
        } catch { $bad += "$($b.id): settings do not parse: $($_.Exception.Message)"; continue }

        if (-not $s.permissions.deny) { $bad += "$($b.id): settings.json has no deny rules" }
        if (-not $l.permissions.allow) { $bad += "$($b.id): settings.local.json has no allow rules" }
        # The failure the root CLAUDE.md calls out by name: allow rules in
        # settings.json are ignored until the workspace is trusted, so an
        # unattended run is denied everything and fails identically every time.
        if ($s.permissions.allow) { $bad += "$($b.id): allow rules in settings.json are ignored until the workspace is trusted; move them to settings.local.json" }
        # And the other one: Write(...) rules are not evaluated by file
        # permission checks at all, so a Write(...) deny protects nothing.
        foreach ($rule in @($s.permissions.deny) + @($l.permissions.allow)) {
            if ("$rule" -like "Write(*") { $bad += "$($b.id): rule '$rule' uses Write(...), which file permission checks do not evaluate; use Edit(...)" }
        }
    }
    if ($bad.Count -eq 0) {
        Add-Probe "bots:settings-shape" "pass" "$checked bots split allow/deny correctly and use Edit(...) rules"
    } else {
        Add-Probe "bots:settings-shape" "fail" "$($bad.Count) settings problems" ($bad -join "`n")
    }
}

# ---------------------------------------------------------- schedule:tasks
if (Test-Wanted "schedule:tasks") {
    $missing = @(); $found = 0
    foreach ($b in ($bots | Where-Object { $_.task })) {
        $t = Get-ScheduledTask -TaskName $b.task -ErrorAction SilentlyContinue
        if (-not $t) { $missing += "$($b.task) is not registered"; continue }
        $found++
        $info = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
        if ($info -and $info.NextRunTime -and $info.NextRunTime -lt (Get-Date)) {
            $missing += "$($b.task) next run $($info.NextRunTime) is in the past"
        }
        if ($t.State -eq "Disabled") { $missing += "$($b.task) is disabled" }
    }
    if ($missing.Count -eq 0) {
        Add-Probe "schedule:tasks" "pass" "$found scheduled tasks registered and enabled"
    } else {
        Add-Probe "schedule:tasks" "fail" "$($missing.Count) schedule problems" ($missing -join "`n")
    }
}

# ------------------------------------------------------------ bots:freshness
if (Test-Wanted "bots:freshness") {
    # "Has never run" and "has stopped running" are different facts and only the
    # second is a failure. Conflating them meant a newly registered bot failed
    # this probe every day until its first run -- and since a failing probe is
    # what makes run_repair.ps1 invoke the agent, a bot that had simply not
    # started yet would have spent tokens every morning to be told so.
    # NextRunTime alone cannot tell those two apart. For a recurring task it is
    # *always* in the future -- the scheduler rolls it forward after every fire,
    # success or not -- so asking only that question made "has not run yet" the
    # unconditional answer, and a bot that fired and died read as pass forever.
    # That is what happened on 2026-08-04: sam-research's task fired at 10:57,
    # aborted on a stderr line, wrote nothing, and the 12:41 health check still
    # reported 12/12 green. What actually distinguishes the two cases is
    # LastRunTime and LastTaskResult, so this probe reads those instead.
    $stale = @(); $pending = @(); $fresh = 0
    foreach ($b in ($bots | Where-Object { $_.maxAgeDays })) {
        $lastRun = $null; $lastResult = $null; $nextRun = $null
        if ($b.task) {
            $t = Get-ScheduledTask -TaskName $b.task -ErrorAction SilentlyContinue
            if ($t) {
                $info = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
                if ($info) {
                    $nextRun = $info.NextRunTime
                    $lastResult = $info.LastTaskResult
                    # The scheduler reports 1999-11-30 for a task that has never
                    # fired, not $null, so a plain truthiness test on LastRunTime
                    # says "it ran" about a task that never has.
                    if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $lastRun = $info.LastRunTime }
                }
            }
        }
        # 267011 (0x41303) "has not yet run" and 267009 (0x41301) "currently
        # running" are status codes the scheduler parks in LastTaskResult, not
        # exit codes. Treating either as a failure would fail this probe against
        # a task that is mid-run at 07:15 every morning.
        $resultBad = ($null -ne $lastResult) -and ($lastResult -ne 0) -and
                     ($lastResult -ne 267011) -and ($lastResult -ne 267009)

        $dir = Join-Path $agency "$($b.id)\runs"
        $reports = @()
        if (Test-Path $dir) {
            $reports = Get-ChildItem $dir -Filter "*.md" -File -ErrorAction SilentlyContinue |
                Where-Object { $_.BaseName -match '^\d{4}-\d{2}-\d{2}$' } |
                Sort-Object BaseName -Descending
        }

        if ($reports.Count -eq 0) {
            if ($lastRun) {
                # Fired at least once and still produced nothing. This is the
                # case the probe used to miss entirely.
                $why = "$($b.id) task last fired $($lastRun.ToString('yyyy-MM-dd HH:mm')) and has still written no run report"
                if ($resultBad) { $why += " (last result $lastResult)" }
                $stale += $why
            } elseif ($nextRun -and $nextRun -gt (Get-Date)) {
                # Genuinely not started yet. Still not a failure -- a failing
                # probe is what makes run_repair.ps1 spend an agent, and a bot
                # that simply has not reached its first run would burn one every
                # morning to be told so.
                $pending += "$($b.id) has not run yet; first run $($nextRun.ToString('yyyy-MM-dd HH:mm'))"
            } else {
                $stale += "$($b.id) has no run report and no future scheduled run"
            }
            continue
        }

        $newest = [datetime]::ParseExact($reports[0].BaseName, "yyyy-MM-dd", $null)
        $age = ((Get-Date) - $newest).Days
        if ($age -gt $b.maxAgeDays) {
            $stale += "$($b.id) newest report is $($reports[0].BaseName), $age days old (limit $($b.maxAgeDays))"
        } elseif ($lastRun -and $lastRun.Date -gt $newest.Date) {
            # The same silent death, on a bot that has run successfully before.
            # Its newest report is inside the cadence, so the age check above is
            # happy, while the most recent fire wrote nothing at all.
            $stale += "$($b.id) task fired $($lastRun.ToString('yyyy-MM-dd HH:mm')) but its newest run report is still $($reports[0].BaseName)"
        } elseif ($resultBad) {
            $stale += "$($b.id) reported within its cadence but its last scheduled run exited $lastResult"
        } else { $fresh++ }
    }

    $note = "$fresh scheduled bots reported within their cadence"
    if ($pending.Count) { $note += "; $($pending.Count) awaiting a first run" }
    if ($stale.Count -eq 0) {
        Add-Probe "bots:freshness" "pass" $note $(if ($pending.Count) { $pending -join "`n" } else { $null })
    } else {
        Add-Probe "bots:freshness" "fail" "$($stale.Count) bots are overdue" (($stale + $pending) -join "`n")
    }
}

# ------------------------------------------------- finance:account-integrity
if (Test-Wanted "finance:account-integrity") {
    $pfPath = Join-Path $agency "finance-research\state\portfolio.json"
    if (-not (Test-Path $pfPath)) {
        Add-Probe "finance:account-integrity" "skip" "no paper account at $pfPath"
    } else {
        $bad = @()
        try {
            $pf = Get-Content $pfPath -Raw | ConvertFrom-Json
            if ($pf.schema -ne 1) { $bad += "unexpected schema $($pf.schema)" }
            if ($pf.cash -lt 0) { $bad += "cash is negative ($($pf.cash)); this account has no leverage" }
            foreach ($p in $pf.positions.PSObject.Properties) {
                if ($p.Value.shares -le 0) { $bad += "$($p.Name) holds $($p.Value.shares) shares; shorting is not allowed" }
                if ($p.Value.avg_cost -le 0) { $bad += "$($p.Name) has a non-positive cost basis" }
            }
            $dates = @($pf.equity_curve | ForEach-Object { $_.date })
            if ($dates.Count -ne ($dates | Select-Object -Unique).Count) { $bad += "equity_curve has duplicate dates" }
            if ($dates.Count -gt 1) {
                $sorted = $dates | Sort-Object
                if (-not ((Compare-Object $dates $sorted -SyncWindow 0) -eq $null)) { $bad += "equity_curve dates are out of order" }
            }
            foreach ($o in @($pf.pending_orders)) {
                if ("$($o.for_session)" -notmatch '^\d{4}-\d{2}-\d{2}$') { $bad += "pending order for $($o.symbol) has a bad for_session '$($o.for_session)'" }
            }
        } catch { $bad += "portfolio.json unreadable: $($_.Exception.Message)" }

        if ($bad.Count -eq 0) {
            Add-Probe "finance:account-integrity" "pass" "paper account reconciles and breaks no limit"
        } else {
            Add-Probe "finance:account-integrity" "fail" "$($bad.Count) account problems" ($bad -join "`n")
        }
    }
}

# ------------------------------------------------------------------ output

$failed = @($probes | Where-Object { $_.status -eq "fail" })
$skipped = @($probes | Where-Object { $_.status -eq "skip" })
$status = if ($failed.Count -gt 0) { "failed" } elseif ($skipped.Count -gt 0) { "degraded" } else { "ok" }

$result = [pscustomobject]@{
    generated_at = (Get-Date).ToString("o")
    agency_root  = $agency
    status       = $status
    counts       = [pscustomobject]@{
        total = $probes.Count
        pass  = @($probes | Where-Object { $_.status -eq "pass" }).Count
        fail  = $failed.Count
        skip  = $skipped.Count
    }
    failures     = @($failed | ForEach-Object { $_.name })
    probes       = @($probes)
}

$json = $result | ConvertTo-Json -Depth 6
if ($Out) {
    # Resolved to an absolute path FIRST, against PowerShell's $PWD, because the
    # two writers below disagree about what a relative path means. Test-Path and
    # New-Item are cmdlets and resolve against $PWD; [System.IO.File] is .NET and
    # resolves against [Environment]::CurrentDirectory, which Set-Location never
    # updates. A relative -Out therefore created the directory in one place and
    # wrote the JSON to another -- silently, since both calls succeed.
    #
    # $PWD is the documented meaning: the header's own example is run from the
    # bot directory. Resolve-Path is not used because it throws on a path that
    # does not exist yet, which is the normal case here.
    # Path::Combine, not Join-Path: Combine returns its second argument unchanged
    # when that argument is already rooted, so an absolute -Out passes through.
    # Join-Path would concatenate regardless and produce "C:\bot\C:\tmp\x.json".
    $outPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PWD.ProviderPath, $Out))
    $dir = Split-Path -Parent $outPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    # No BOM: these files are read back by python's json.load, which chokes on
    # one, and PowerShell 5.1's Out-File -Encoding utf8 writes a BOM.
    [System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}
if (-not $Quiet) { Write-Output $json }

# Exit code is for the caller's `if`, not for a human: 0 healthy, 1 something
# failed. Skips do not fail the run -- a missing toolchain is not a broken bot.
if ($failed.Count -gt 0) { exit 1 } else { exit 0 }
