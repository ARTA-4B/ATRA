<#
.SYNOPSIS
  ATRA backup for Windows PowerShell 5.1+: the same encrypted archive that
  scripts/backup.sh produces, so a backup made here restores on Linux or
  macOS with restore.sh and the other way round.

.DESCRIPTION
  Snapshots the SQLite database (which holds the encrypted wallet vault) with
  SQLite's own VACUUM INTO, adds the .env configuration when one exists, and
  encrypts everything with a passphrase you choose:
  openssl enc AES-256-CBC, PBKDF2-SHA256, 600000 iterations.

  The archive is written to a local directory. Nothing here touches the
  network, and nothing here prints a key, a password or the vault contents.

  openssl is required. Git for Windows ships one; the script finds it even
  when it is not on PATH. Without openssl the script refuses rather than
  writing a plaintext backup.

.PARAMETER Docker
  Snapshot the database inside the compose volume (default when
  docker-compose.yml is in the repo and docker is installed).
.PARAMETER DataDir
  Snapshot a local data directory instead (non-Docker install).
.PARAMETER EnvFile
  The .env to include. Default <repo>\.env, skipped if absent.
.PARAMETER Out
  Output directory. Default <repo>\backups.
.PARAMETER PassphraseFile
  Read the passphrase (first line, ASCII/UTF-8) from a file instead of
  prompting. For unattended use only; protect the file.

.EXAMPLE
  .\scripts\backup.ps1
  .\scripts\backup.ps1 -DataDir "$env:LOCALAPPDATA\atra"
#>
[CmdletBinding()]
param(
  [switch]$Docker,
  [string]$DataDir = '',
  [string]$EnvFile = '',
  [string]$Out = '',
  [string]$PassphraseFile = ''
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$Pbkdf2Iter = 600000

function Fail([string]$message) {
  [Console]::Error.WriteLine("backup: $message")
  exit 1
}
function Note([string]$message) {
  [Console]::Error.WriteLine("backup: $message")
}
function Find-Tool([string]$name, [string[]]$candidates) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}
function Hash-File([string]$path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower()
}
function Run-Native([string]$exe, [string[]]$argv) {
  # Runs a native program and returns its stdout lines. stderr is left alone
  # (it reaches the console), so Windows PowerShell 5.1 does not turn it into
  # a terminating error under $ErrorActionPreference = 'Stop'.
  $out = & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe exited with $LASTEXITCODE" }
  return $out
}
function Invoke-Quiet([string]$exe, [string[]]$argv) {
  # Runs a native program with stderr folded into the output and returns
  # @{ Out; Code }. 5.1 wraps redirected stderr lines in ErrorRecords, which
  # would terminate the script under 'Stop', so the preference is relaxed for
  # the duration of the call and the exit code is checked by the caller.
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
function Invoke-OpensslWithPassphrase([string]$exe, [string]$passphrase, [string[]]$argv) {
  # The passphrase goes to openssl on stdin as the exact bytes backup.sh sends:
  # UTF-8 followed by a single LF. PowerShell's own pipeline would append CRLF
  # and openssl would keep the CR as part of the passphrase, which is why the
  # process is started directly. The passphrase is never an argument and never
  # touches the environment or the disk. openssl's output is discarded: on a
  # wrong passphrase it says only "bad decrypt".
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = (($argv | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\"') + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  # .NET Framework builds the child's stdin writer from [Console]::InputEncoding
  # and writes that encoding's preamble on close. With a code page of 65001
  # that is a UTF-8 BOM, which openssl would treat as part of the passphrase,
  # so a preamble-free encoding is installed for the duration of the call.
  $prevInputEncoding = [Console]::InputEncoding
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
    try {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($passphrase + "`n")
      $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
      $p.StandardInput.BaseStream.Flush()
      $p.StandardInput.Close()
      [Array]::Clear($bytes, 0, $bytes.Length)
      $null = $p.StandardOutput.ReadToEnd()
      $null = $p.StandardError.ReadToEnd()
      $p.WaitForExit()
      return $p.ExitCode
    } finally {
      $p.Dispose()
    }
  } finally {
    [Console]::InputEncoding = $prevInputEncoding
  }
}

# --- prerequisites ----------------------------------------------------------

$git = $null
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) { $git = Split-Path -Parent (Split-Path -Parent $gitCmd.Source) }
$openssl = Find-Tool 'openssl' @(
  $(if ($git) { Join-Path $git 'usr\bin\openssl.exe' }),
  $(if ($git) { Join-Path $git 'mingw64\bin\openssl.exe' }),
  (Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe'),
  (Join-Path $env:ProgramFiles 'Git\mingw64\bin\openssl.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Git\usr\bin\openssl.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Git\mingw64\bin\openssl.exe')
)
if (-not $openssl) { Fail 'openssl was not found (install Git for Windows, or run scripts/backup.sh from Git Bash); refusing to write an unencrypted backup' }
$encHelp = (Invoke-Quiet $openssl @('enc', '-help')).Out -join "`n"
if ($encHelp -notmatch '-pbkdf2') { Fail "this openssl does not support 'enc -pbkdf2'; upgrade it rather than weakening the KDF" }

$tar = Find-Tool 'tar' @((Join-Path $env:SystemRoot 'System32\tar.exe'))
if (-not $tar) { Fail 'tar.exe was not found (Windows 10 1803+ ships it)' }

$mode = ''
if ($Docker) { $mode = 'docker' }
elseif ($DataDir) { $mode = 'local' }
elseif ((Test-Path (Join-Path $RepoDir 'docker-compose.yml')) -and (Get-Command docker -ErrorAction SilentlyContinue)) { $mode = 'docker' }
else { Fail 'say where the data is: -Docker or -DataDir DIR' }

$envGiven = [bool]$EnvFile
if (-not $EnvFile) { $EnvFile = Join-Path $RepoDir '.env' }
if (-not $Out) { $Out = Join-Path $RepoDir 'backups' }

# --- passphrase -------------------------------------------------------------

function Read-Passphrase {
  if ($PassphraseFile) {
    if (-not (Test-Path -LiteralPath $PassphraseFile)) { Fail "cannot read passphrase file $PassphraseFile" }
    $p = (Get-Content -LiteralPath $PassphraseFile -TotalCount 1)
    if ($null -eq $p) { $p = '' }
  } else {
    $s1 = Read-Host -AsSecureString 'Backup passphrase (min 12 characters, not echoed)'
    $s2 = Read-Host -AsSecureString 'Repeat passphrase'
    $b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1)
    $b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2)
    try {
      $p = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b1)
      $q = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b2)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1)
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
    }
    if ($p -ne $q) { Fail 'passphrases do not match' }
  }
  if ($p.Length -lt 12) { Fail 'passphrase must be at least 12 characters' }
  return $p
}

# --- staging ----------------------------------------------------------------

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$name = "atra-backup-$stamp"
$work = Join-Path ([IO.Path]::GetTempPath()) ("atra-backup-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $work | Out-Null
$stage = Join-Path $work $name
New-Item -ItemType Directory -Path (Join-Path $stage 'config') | Out-Null

# The same snapshot program backup.sh uses: VACUUM INTO gives a consistent copy
# of a live WAL database and the sha256 lets the copy be verified. It contains
# no double quotes so it survives PowerShell's native-argument quoting.
$snapshotJs = "const s=require('node:sqlite'),f=require('node:fs'),c=require('node:crypto'),a=process.argv;const d=new s.DatabaseSync(a[1]);d.prepare('VACUUM INTO ?').run(a[2]);d.close();console.log('sha256 '+c.createHash('sha256').update(f.readFileSync(a[2])).digest('hex'));"

try {
  $want = ''
  $sourceDesc = ''
  switch ($mode) {
    'local' {
      $src = Join-Path $DataDir 'atra.db'
      if (-not (Test-Path -LiteralPath $src)) { Fail "no atra.db in $DataDir" }
      $node = Get-Command node -ErrorAction SilentlyContinue
      if (-not $node) { Fail 'node is needed to snapshot a live database (the runtime needs it too)' }
      Note "snapshotting $src"
      $lines = Run-Native $node.Source @('-e', $snapshotJs, $src, (Join-Path $stage 'atra.db'))
      $want = (($lines | Where-Object { $_ -like 'sha256 *' } | Select-Object -Last 1) -replace '^sha256 ', '')
      $sourceDesc = "local:$DataDir"
    }
    'docker' {
      if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'docker is not installed' }
      Set-Location $RepoDir
      if ((Invoke-Quiet 'docker' @('compose', 'version')).Code -ne 0) { Fail 'docker compose v2 is required' }
      $existing = (Invoke-Quiet 'docker' @('compose', 'ps', '-a', '-q', 'atra')).Out -join ''
      if (-not $existing.Trim()) {
        if ((Invoke-Quiet 'docker' @('compose', 'create', '--no-build', 'atra')).Code -ne 0) { Fail "no atra container; run 'docker compose up -d' once first" }
      }
      $remote = "/data/.backup-$stamp.db"
      Note 'snapshotting the database inside the atra-data volume'
      $lines = Run-Native 'docker' @('compose', 'run', '--rm', '--no-deps', '-T', 'atra', 'node', '-e', $snapshotJs, '/data/atra.db', $remote)
      $want = (($lines | Where-Object { $_ -like 'sha256 *' } | Select-Object -Last 1) -replace '^sha256 ', '')
      Run-Native 'docker' @('compose', 'cp', "atra:$remote", (Join-Path $stage 'atra.db')) | Out-Null
      if ((Invoke-Quiet 'docker' @('compose', 'run', '--rm', '--no-deps', '-T', 'atra', 'node', '-e', "require('node:fs').unlinkSync(process.argv[1])", $remote)).Code -ne 0) { Note "warning: could not remove $remote from the volume" }
      $sourceDesc = 'docker:atra-data'
    }
  }

  $got = Hash-File (Join-Path $stage 'atra.db')
  if ($got -ne $want) { Fail "snapshot hash mismatch (expected $want, got $got); refusing to archive a corrupt copy" }

  $envDesc = 'none found'
  if (Test-Path -LiteralPath $EnvFile) {
    Copy-Item -LiteralPath $EnvFile -Destination (Join-Path $stage 'config\.env')
    $envDesc = 'included'
  } elseif ($envGiven) {
    Fail "env file $EnvFile does not exist"
  } else {
    Remove-Item (Join-Path $stage 'config')
  }

  $runtimeVersion = 'unknown'
  $pkg = Join-Path $RepoDir 'runtime\package.json'
  if (Test-Path $pkg) {
    $m = [regex]::Match((Get-Content $pkg -Raw), '"version"\s*:\s*"([^"]+)"')
    if ($m.Success) { $runtimeVersion = $m.Groups[1].Value }
  }

  # MANIFEST, byte-identical in shape to the one backup.sh writes (LF endings).
  $manifest = New-Object System.Text.StringBuilder
  [void]$manifest.Append("atra-backup manifest v1`n")
  [void]$manifest.Append("created_utc $stamp`n")
  [void]$manifest.Append("source $sourceDesc`n")
  [void]$manifest.Append("runtime_version $runtimeVersion`n")
  [void]$manifest.Append("files`n")
  $files = Get-ChildItem -LiteralPath $stage -Recurse -File -Force | Where-Object { $_.Name -ne 'MANIFEST' } |
    ForEach-Object { $_.FullName.Substring($stage.Length + 1).Replace('\', '/') } | Sort-Object
  foreach ($rel in $files) {
    [void]$manifest.Append(("{0}  {1}`n" -f (Hash-File (Join-Path $stage $rel)), $rel))
  }
  [IO.File]::WriteAllText((Join-Path $stage 'MANIFEST'), $manifest.ToString(), (New-Object System.Text.UTF8Encoding($false)))

  # --- encrypt --------------------------------------------------------------

  $pass = Read-Passphrase

  $plain = Join-Path $work 'payload.tar.gz'
  Run-Native $tar @('-czf', $plain, '-C', $work, $name) | Out-Null

  $outer = Join-Path $work 'outer'
  New-Item -ItemType Directory -Path $outer | Out-Null

  $rc = Invoke-OpensslWithPassphrase $openssl $pass @('enc', '-aes-256-cbc', '-pbkdf2', '-iter', "$Pbkdf2Iter", '-md', 'sha256', '-salt', '-pass', 'stdin', '-in', $plain, '-out', (Join-Path $outer 'payload.enc'))
  $pass = $null
  if ($rc -ne 0) { Fail 'encryption failed' }
  Remove-Item -LiteralPath $plain -Force

  $meta = @"
{
  "format": "atra-backup/1",
  "created_utc": "$stamp",
  "source": "$($sourceDesc.Replace('\', '/'))",
  "cipher": "aes-256-cbc",
  "kdf": "pbkdf2",
  "kdf_md": "sha256",
  "kdf_iter": $Pbkdf2Iter,
  "payload": "payload.enc",
  "payload_contains": "tar.gz of $name/{atra.db,config/.env,MANIFEST}",
  "restore": "scripts/restore.sh, or: openssl enc -d -aes-256-cbc -pbkdf2 -iter $Pbkdf2Iter -md sha256 -in payload.enc | tar -xz"
}
"@
  [IO.File]::WriteAllText((Join-Path $outer 'meta.json'), $meta.Replace("`r`n", "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $outer 'SHA256SUMS'), ("{0}  payload.enc`n" -f (Hash-File (Join-Path $outer 'payload.enc'))), (New-Object System.Text.UTF8Encoding($false)))

  New-Item -ItemType Directory -Path $Out -Force | Out-Null
  # The default output directory sits inside the checkout; make it ignore itself
  # so an archive can never be committed by accident, whatever .gitignore says.
  $ignore = Join-Path $Out '.gitignore'
  if (-not (Test-Path -LiteralPath $ignore)) { [IO.File]::WriteAllText($ignore, "*`n", (New-Object System.Text.UTF8Encoding($false))) }
  $final = Join-Path (Resolve-Path $Out).Path "$name.tar"
  Run-Native $tar @('-cf', $final, '-C', $outer, 'meta.json', 'SHA256SUMS', 'payload.enc') | Out-Null

  $size = (Get-Item -LiteralPath $final).Length
  Note "wrote $final ($size bytes)"
  Note ("database snapshot sha256 {0}... (full hash inside MANIFEST); config {1}" -f $got.Substring(0, 16), $envDesc)
  Note 'the archive opens only with this passphrase, and the vault inside it only with the dashboard password. Store both, separately, offline.'
  Write-Output $final
} finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
