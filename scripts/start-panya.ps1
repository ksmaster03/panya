# Start panya after a reboot: wait for Docker + seekdb, then keep `bun src/index.ts` running.
# Launched hidden at logon by "Startup\Panya.vbs". Output goes to logs\panya.log.

$root = Split-Path -Parent $PSScriptRoot
$bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
$dockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$logDir = Join-Path $root 'logs'
$log = Join-Path $logDir 'panya.log'

function Get-Setting([string]$name, [string]$default) {
  $fromEnv = [Environment]::GetEnvironmentVariable($name)
  if ($fromEnv) { return $fromEnv }
  $envFile = Join-Path $root '.env'
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -Last 1
    if ($line) { return ($line -split '=', 2)[1].Trim() }
  }
  return $default
}

function Write-Log([string]$message) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  # the log is locked while a running panya writes to it; skip the line rather than fail
  try { [IO.File]::AppendAllText($log, "$stamp [start-panya] $message`r`n") } catch {}
}

function Test-Port([int]$port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(2000)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch { return $false } finally { $client.Close() }
}

function Wait-Until([scriptblock]$check, [int]$timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (& $check) { return $true }
    Start-Sleep -Seconds 5
  }
  return $false
}

function Test-Docker {
  & docker info *> $null
  return $LASTEXITCODE -eq 0
}

# Bring up Docker Desktop (if needed) and the seekdb container, then wait for its port.
function Start-Database {
  if (-not (Test-Docker)) {
    if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
      Write-Log 'starting Docker Desktop'
      Start-Process -FilePath $dockerDesktop
    }
    if (-not (Wait-Until { Test-Docker } 600)) { Write-Log 'docker engine not ready after 10 min'; return $false }
  }
  if (-not (Test-Port $dbPort)) {
    Write-Log 'starting seekdb container'
    & docker compose --project-directory $root up -d seekdb *> $null
  }
  if (-not (Wait-Until { Test-Port $dbPort } 300)) { Write-Log "seekdb port $dbPort not ready after 5 min"; return $false }
  return $true
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item -Force $log "$log.1" }

$port = [int](Get-Setting 'PANYA_PORT' '6800')
$dbPort = [int](Get-Setting 'SEEKDB_PORT' '2881')

$created = $false
$mutex = New-Object Threading.Mutex($true, "Global\panya-launcher-$port", [ref]$created)
if (-not $created) { Write-Log "launcher for port $port already running, exiting"; exit 0 }
if (Test-Port $port) { Write-Log "panya already listening on :$port, exiting"; exit 0 }

Set-Location $root
while ($true) {
  if (Start-Database) {
    Write-Log "starting panya on :$port"
    # cmd handles the redirect so bun's stdout/stderr land in the log as-is
    & cmd /c "`"$bun`" src/index.ts >> `"$log`" 2>&1"
    Write-Log "panya exited with code $LASTEXITCODE, restarting in 15s"
  }
  Start-Sleep -Seconds 15
}
