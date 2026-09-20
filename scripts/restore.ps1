<#
.SYNOPSIS
  ATRA restore for Windows PowerShell 5.1+: the reverse of backup.ps1 and
  backup.sh. Decrypts an archive with the operator's passphrase, verifies
  every hash, and installs the database into a data directory or the
  compose volume.

.DESCRIPTION
  Refuses to overwrite an existing atra.db unless -Force is given (the old
  file is then kept as atra.db.pre-restore-<stamp>, never deleted), and
  refuses while a runtime is running. Nothing here touches the network or
  prints a secret.

  The vault inside the restored database still needs the dashboard password
  it was created with; the backup passphrase only opens the archive.

.PARAMETER Archive
  The atra-backup-<stamp>.tar file.
.PARAMETER Docker
  Install into the atra-data compose volume.
.PARAMETER DataDir
  Install into a local data directory (created if missing).
.PARAMETER Force
  Replace an existing database (kept as a .pre-restore-<stamp> copy).
.PARAMETER EnvOut
  Also write the archived .env to this path. Refused if it exists, unless
  -Force. Without it only the database is restored.
.PARAMETER PassphraseFile
  Read the passphrase from a file instead of prompting.

.EXAMPLE
  .\scripts\restore.ps1 .\backups\atra-backup-20260920T011912Z.tar -DataDir "$env:LOCALAPPDATA\atra"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Archive,
  [switch]$Docker,
  [string]$DataDir = '',
  [switch]$Force,
  [string]$EnvOut = '',
  [string]$PassphraseFile = ''
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = (Resolve-Path (Join-Path $ScriptDir '..')).Path

function Fail([string]$message) {
  [Console]::Error.WriteLine("restore: $message")
  exit 1
}
function Note([string]$message) {
  [Console]::Error.WriteLine("restore: $message")
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

if (-not (Test-Path -LiteralPath $Archive)) { Fail "no such file: $Archive" }
$Archive = (Resolve-Path -LiteralPath $Archive).Path

$mode = ''
if ($Docker) { $mode = 'docker' } elseif ($DataDir) { $mode = 'local' } else { Fail 'say where to restore: -Docker or -DataDir DIR' }

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
if (-not $openssl) { Fail 'openssl was not found (install Git for Windows, or run scripts/restore.sh from Git Bash)' }
$tar = Find-Tool 'tar' @((Join-Path $env:SystemRoot 'System32\tar.exe'))
if (-not $tar) { Fail 'tar.exe was not found (Windows 10 1803+ ships it)' }

function Read-Passphrase {
  if ($PassphraseFile) {
    if (-not (Test-Path -LiteralPath $PassphraseFile)) { Fail "cannot read passphrase file $PassphraseFile" }
    $p = (Get-Content -LiteralPath $PassphraseFile -TotalCount 1)
    if ($null -eq $p) { $p = '' }
  } else {
    $s = Read-Host -AsSecureString 'Backup passphrase (not echoed)'
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { $p = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  }
  if (-not $p) { Fail 'empty passphrase' }
  return $p
}

# --- refuse while the runtime is running -------------------------------------

$port = if ($env:ATRA_PORT) { $env:ATRA_PORT } else { '3000' }
switch ($mode) {
  'local' {
    $running = $false
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
      if ($r.StatusCode -eq 200) { $running = $true }
    } catch { $running = $false }
    if ($running) { Fail "a runtime is answering on 127.0.0.1:$port; stop it before restoring" }
  }
  'docker' {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'docker is not installed' }
    Set-Location $RepoDir
    if ((Invoke-Quiet 'docker' @('compose', 'version')).Code -ne 0) { Fail 'docker compose v2 is required' }
    $runningId = (Invoke-Quiet 'docker' @('compose', 'ps', '--status', 'running', '-q', 'atra')).Out -join ''
    if ($runningId.Trim()) { Fail "the atra container is running; 'docker compose stop' first" }
    $existing = (Invoke-Quiet 'docker' @('compose', 'ps', '-a', '-q', 'atra')).Out -join ''
    if (-not $existing.Trim()) {
      if ((Invoke-Quiet 'docker' @('compose', 'create', '--no-build', 'atra')).Code -ne 0) { Fail "no atra container; run 'docker compose up -d' once, then 'docker compose stop'" }
    }
  }
}

# --- unpack and decrypt -----------------------------------------------------

$work = Join-Path ([IO.Path]::GetTempPath()) ("atra-restore-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $outer = Join-Path $work 'outer'
  New-Item -ItemType Directory -Path $outer | Out-Null
  if ((Invoke-Quiet $tar @('-xf', $Archive, '-C', $outer)).Code -ne 0) { Fail 'not a readable archive' }
  $metaPath = Join-Path $outer 'meta.json'
  $payload = Join-Path $outer 'payload.enc'
  if (-not (Test-Path -LiteralPath $metaPath)) { Fail 'meta.json missing; this is not an ATRA backup' }
  if (-not (Test-Path -LiteralPath $payload)) { Fail 'payload.enc missing' }

  $metaText = Get-Content -LiteralPath $metaPath -Raw
  $m = [regex]::Match($metaText, '"format"\s*:\s*"([^"]+)"')
  if (-not $m.Success -or $m.Groups[1].Value -ne 'atra-backup/1') { Fail "unsupported backup format" }
  $m = [regex]::Match($metaText, '"kdf_iter"\s*:\s*(\d+)')
  if (-not $m.Success) { Fail 'meta.json has no kdf_iter' }
  $iter = [int]$m.Groups[1].Value
  $created = 'unknown time'
  $m = [regex]::Match($metaText, '"created_utc"\s*:\s*"([^"]+)"')
  if ($m.Success) { $created = $m.Groups[1].Value }

  $sums = Join-Path $outer 'SHA256SUMS'
  if (Test-Path -LiteralPath $sums) {
    $want = ((Get-Content -LiteralPath $sums -TotalCount 1) -split ' ')[0].ToLower()
    if ($want -ne (Hash-File $payload)) { Fail 'payload.enc is damaged (sha256 mismatch); this archive cannot be trusted' }
  }

  $pass = Read-Passphrase
  Note "decrypting backup from $created"
  $plainTgz = Join-Path $work 'payload.tar.gz'
  $rc = Invoke-OpensslWithPassphrase $openssl $pass @('enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', "$iter", '-md', 'sha256', '-pass', 'stdin', '-in', $payload, '-out', $plainTgz)
  $pass = $null
  if ($rc -ne 0) { Fail 'decryption failed: wrong passphrase or damaged archive' }

  $plain = Join-Path $work 'plain'
  New-Item -ItemType Directory -Path $plain | Out-Null
  if ((Invoke-Quiet $tar @('-xzf', $plainTgz, '-C', $plain)).Code -ne 0) { Fail 'decrypted payload is not a valid tar.gz: wrong passphrase or damaged archive' }
  Remove-Item -LiteralPath $plainTgz -Force

  $stage = Get-ChildItem -LiteralPath $plain -Directory | Where-Object { $_.Name -like 'atra-backup-*' } | Select-Object -First 1
  if (-not $stage) { Fail 'payload has no atra-backup-* directory' }
  $stage = $stage.FullName
  $manifestPath = Join-Path $stage 'MANIFEST'
  $dbPath = Join-Path $stage 'atra.db'
  if (-not (Test-Path -LiteralPath $manifestPath)) { Fail 'MANIFEST missing from payload' }
  if (-not (Test-Path -LiteralPath $dbPath)) { Fail 'atra.db missing from payload' }

  $inFiles = $false
  foreach ($line in (Get-Content -LiteralPath $manifestPath)) {
    if (-not $inFiles) { if ($line -eq 'files') { $inFiles = $true }; continue }
    if (-not $line.Trim()) { continue }
    $parts = $line -split '  ', 2
    if ($parts.Count -ne 2) { Fail "unreadable MANIFEST line" }
    $wantHash = $parts[0].ToLower(); $rel = $parts[1]
    $full = Join-Path $stage ($rel.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $full)) { Fail "MANIFEST names $rel but it is missing" }
    if ((Hash-File $full) -ne $wantHash) { Fail "$rel does not match its MANIFEST hash; refusing to install a corrupt file" }
  }

  $dbHash = Hash-File $dbPath

  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $check = 'unavailable'
    $r = Invoke-Quiet $node.Source @('-e', "const s=require('node:sqlite');const d=new s.DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('PRAGMA integrity_check').get().integrity_check);d.close();", $dbPath)
    if ($r.Code -eq 0 -and $r.Out.Count -gt 0) { $check = $r.Out[-1] }
    if ($check -ne 'ok' -and $check -ne 'unavailable') { Fail "SQLite integrity_check reported: $check" }
  }

  # --- install --------------------------------------------------------------

  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $forceFlag = if ($Force) { '1' } else { '0' }

  switch ($mode) {
    'local' {
      New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
      $target = Join-Path $DataDir 'atra.db'
      if (Test-Path -LiteralPath $target) {
        if (-not $Force) { Fail "$target exists; pass -Force to replace it (the old file is kept)" }
        $kept = "$target.pre-restore-$stamp"
        Move-Item -LiteralPath $target -Destination $kept
        foreach ($suffix in @('-wal', '-shm')) { if (Test-Path -LiteralPath "$target$suffix") { Remove-Item -LiteralPath "$target$suffix" -Force } }
        Note "previous database kept as $kept"
      }
      Copy-Item -LiteralPath $dbPath -Destination "$target.incoming"
      if ((Hash-File "$target.incoming") -ne $dbHash) { Fail "copy into $DataDir did not verify" }
      Move-Item -LiteralPath "$target.incoming" -Destination $target
      Note ("installed {0} (sha256 {1}...)" -f $target, $dbHash.Substring(0, 16))
    }
    'docker' {
      $remote = "/data/.restore-$stamp.db"
      try { Run-Native 'docker' @('compose', 'cp', $dbPath, "atra:$remote") | Out-Null } catch { Fail 'copy into the container failed' }
      $installJs = "const f=require('node:fs'),c=require('node:crypto'),a=process.argv;const src=a[1],dst=a[2],want=a[3],force=a[4],stamp=a[5];const got=c.createHash('sha256').update(f.readFileSync(src)).digest('hex');if(got!==want){console.error('sha256 mismatch after copy');process.exit(4)}if(f.existsSync(dst)){if(force!=='1'){f.unlinkSync(src);console.error('refusing to overwrite an existing database; pass -Force (the old file is kept)');process.exit(3)}const b=dst+'.pre-restore-'+stamp;f.renameSync(dst,b);for(const x of ['-wal','-shm']){try{f.unlinkSync(dst+x)}catch(e){}}console.log('previous database kept as '+b)}f.copyFileSync(src,dst+'.incoming');f.renameSync(dst+'.incoming',dst);f.unlinkSync(src);console.log('installed '+dst);"
      $r = Invoke-Quiet 'docker' @('compose', 'run', '--rm', '--no-deps', '-T', 'atra', 'node', '-e', $installJs, $remote, '/data/atra.db', $dbHash, $forceFlag, $stamp)
      foreach ($line in $r.Out) { if ($line) { Note $line } }
      if ($r.Code -ne 0) { Fail 'install inside the volume failed' }
      Note ("installed /data/atra.db in the atra-data volume (sha256 {0}...)" -f $dbHash.Substring(0, 16))
    }
  }

  # --- config ---------------------------------------------------------------

  $envInArchive = Join-Path $stage 'config\.env'
  if ($EnvOut) {
    if (Test-Path -LiteralPath $envInArchive) {
      if ((Test-Path -LiteralPath $EnvOut) -and -not $Force) { Fail "$EnvOut exists; pass -Force to replace it" }
      Copy-Item -LiteralPath $envInArchive -Destination $EnvOut -Force
      Note "wrote config to $EnvOut"
    } else {
      Note "the archive holds no config file; nothing written to $EnvOut"
    }
  } elseif (Test-Path -LiteralPath $envInArchive) {
    Note 'the archive also holds a .env; pass -EnvOut FILE to restore it'
  }

  Note 'done. Start the runtime and sign in with the dashboard password the vault was created with.'
} finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
