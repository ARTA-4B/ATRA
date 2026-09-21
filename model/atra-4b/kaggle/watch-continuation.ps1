param(
    [string]$Kernel = 'atra12/atra-4b-continuation-20260921',
    [string]$OutputDirectory = 'C:\ATRA\artifacts\atra-training-20260921\remote',
    [int]$MaxHours = 13
)
$ErrorActionPreference = 'Stop'
$jobOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $jobOutput -Force | Out-Null
$kaggleCommand = (Get-Command kaggle -ErrorAction Stop).Source
$deadline = [DateTime]::UtcNow.AddHours($MaxHours)
$lastStatus = ''
while ([DateTime]::UtcNow -lt $deadline) {
    $statusLines = & $kaggleCommand kernels status $Kernel 2>&1
    $statusExitCode = $LASTEXITCODE
    $status = ($statusLines | Out-String).Trim()
    $record = [ordered]@{
        checkedAt = [DateTime]::UtcNow.ToString('o')
        kernel = $Kernel
        status = $status
        statusExitCode = $statusExitCode
    }
    $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $jobOutput 'watch-status.json') -Encoding UTF8
    if ($status -ne $lastStatus) {
        Write-Output "$($record.checkedAt) $status"
        $lastStatus = $status
    }
    if ($statusExitCode -eq 0 -and $status -match 'KernelWorkerStatus\.(COMPLETE|ERROR|CANCELLED|CANCELED)') {
        # Keep the selected adapter, reports, raw replies and logs. Exclude
        # intermediate checkpoints/optimizer states, which are large.
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            & $kaggleCommand kernels output $Kernel -p $jobOutput --page-size 200 --file-pattern '^(?!.*checkpoint-).*(json|jsonl|txt|log|jinja|safetensors|yaml|py)$'
            if ($LASTEXITCODE -eq 0) { break }
            Start-Sleep -Seconds 30
        }
        if ($LASTEXITCODE -ne 0) { throw 'Run ended, but output download failed; retry kaggle kernels output.' }
        Write-Output "Remote job ended. Outputs saved to $jobOutput. Inspect result.json; kernel COMPLETE alone does not mean evaluation passed."
        exit 0
    }
    Start-Sleep -Seconds 30
}
throw 'Watcher reached its time limit. The remote job was not cancelled; check Kaggle status.'
