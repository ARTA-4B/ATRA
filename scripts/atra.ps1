<#
.SYNOPSIS
  ATRA lifecycle helper for the Docker install on Windows (PowerShell 5.1+).
  The same commands as scripts/atra.sh.

.DESCRIPTION
  install   check docker, build the image, start it, wait for /health,
            print the dashboard URL
  start     docker compose up -d (and wait for /health)
  stop      docker compose stop (the runtime locks the vault and checkpoints
            the database before exiting)
  restart   stop, then start
  status    container state plus /health and /ready
  update    git pull --ff-only, rebuild, restart, wait for /health
  logs      follow the container logs (the runtime redacts key-shaped values
            before writing a line)
  backup    scripts\backup.ps1 -Docker (prompts for a passphrase)

  Nothing here reads, prints or needs a key, a password or a token. The port
  is published to 127.0.0.1 only; the dashboard is http://127.0.0.1:3000
  unless ATRA_PORT is set in .env.

.EXAMPLE
  .\scripts\atra.ps1 install
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet('install', 'start', 'stop', 'restart', 'status', 'update', 'logs', 'backup', 'help')]
  [string]$Command = 'help',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = (Resolve-Path (Join-Path $ScriptDir '..')).Path
Set-Location $RepoDir

function Fail([string]$message) {
  [Console]::Error.WriteLine("atra: $message")
  exit 1
}
function Note([string]$message) {
  [Console]::Error.WriteLine("atra: $message")
}
function Invoke-Quiet([string]$exe, [string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $exe @argv 2>&1 | ForEach-Object { $_.ToString() }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  return @{ Out = @($out); Code = $code }
}
function Run([string]$exe, [string[]]$argv) {
  # stderr is not redirected on purpose: 5.1 would turn docker's progress
  # output into terminating errors. The exit code decides.
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($argv -join ' ') exited with $LASTEXITCODE" }
}

$port = '3000'
if (Test-Path '.env') {
  $m = Get-Content '.env' | Where-Object { $_ -match '^ATRA_PORT=(\d+)' } | Select-Object -Last 1
  if ($m) { $port = [regex]::Match($m, '^ATRA_PORT=(\d+)').Groups[1].Value }
}
$Url = "http://127.0.0.1:$port"

function Need-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'docker is not installed. Docker Desktop is the supported install path on Windows; see docs/deployment.md' }
  if ((Invoke-Quiet 'docker' @('compose', 'version')).Code -ne 0) { Fail "docker compose v2 is required (the 'docker compose' subcommand)" }
  if ((Invoke-Quiet 'docker' @('info')).Code -ne 0) { Fail 'the docker daemon is not running (start Docker Desktop)' }
}
function Fetch([string]$url) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
    return $r.Content
  } catch {
    $resp = $_.Exception.Response
    if ($resp -and $resp.GetResponseStream) {
      try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); return $sr.ReadToEnd() } catch { return $null }
    }
    return $null
  }
}
function Wait-Healthy {
  [Console]::Error.Write("atra: waiting for $Url/health")
  for ($i = 0; $i -lt 60; $i++) {
    $body = Fetch "$Url/health"
    if ($body -and $body -match '"status":"ok"') { [Console]::Error.WriteLine(''); return }
    [Console]::Error.Write('.')
    Start-Sleep -Seconds 2
  }
  [Console]::Error.WriteLine('')
  Fail "the runtime did not become healthy within two minutes; see '.\scripts\atra.ps1 logs'"
}
function Print-NextSteps {
  $ready = Fetch "$Url/ready"
  if ($ready -and $ready -match '"setupRequired":true') {
    Write-Output "atra: open $Url and complete first-run setup. You start in PAPER mode."
  } else {
    Write-Output "atra: running at $Url"
  }
}

switch ($Command) {
  'install' {
    Need-Docker
    if (-not (Test-Path '.env')) {
      Copy-Item '.env.example' '.env'
      Note 'created .env from .env.example (everything in it is optional)'
    }
    Run 'docker' @('compose', 'build', '--pull')
    Run 'docker' @('compose', 'up', '-d')
    Wait-Healthy
    Print-NextSteps
  }
  'start' {
    Need-Docker
    Run 'docker' @('compose', 'up', '-d')
    Wait-Healthy
    Print-NextSteps
  }
  'stop' {
    Need-Docker
    Run 'docker' @('compose', 'stop')
  }
  'restart' {
    Need-Docker
    Run 'docker' @('compose', 'stop')
    Run 'docker' @('compose', 'up', '-d')
    Wait-Healthy
  }
  'status' {
    Need-Docker
    Run 'docker' @('compose', 'ps')
    Write-Output "--- $Url/health ---"
    $h = Fetch "$Url/health"; if ($h) { Write-Output $h } else { Write-Output 'unreachable' }
    Write-Output "--- $Url/ready ---"
    $r = Fetch "$Url/ready"; if ($r) { Write-Output $r } else { Write-Output '(503 before setup is complete, or unreachable)' }
  }
  'update' {
    Need-Docker
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is not installed' }
    Run 'git' @('pull', '--ff-only')
    Run 'docker' @('compose', 'build', '--pull')
    Run 'docker' @('compose', 'up', '-d')
    Wait-Healthy
    Write-Output ("atra: updated to " + (& git rev-parse --short HEAD))
  }
  'logs' {
    Need-Docker
    & docker compose logs -f --tail 200
  }
  'backup' {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'backup.ps1') -Docker @Rest
    exit $LASTEXITCODE
  }
  default {
    Get-Help $MyInvocation.MyCommand.Path -Detailed
  }
}
