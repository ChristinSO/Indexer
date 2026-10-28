$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$stateFile = Join-Path $projectRoot '.local\server.json'
if (-not (Test-Path -LiteralPath $stateFile)) { Write-Output 'Indexer Alpha is not running.'; exit 0 }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
$serverProcess = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
if ($serverProcess -and $serverProcess.StartTime.ToUniversalTime().ToString('o') -eq $state.started) {
    $session = Invoke-RestMethod 'http://127.0.0.1:8765/api/session'
    Invoke-RestMethod 'http://127.0.0.1:8765/api/shutdown' -Method Post -Headers @{ 'x-indexer-token' = $session.token } | Out-Null
    $serverProcess.WaitForExit(10000) | Out-Null
    if (-not $serverProcess.HasExited) { throw 'Server did not shut down; check .local/server-error.log.' }
}
Remove-Item -LiteralPath $stateFile -Force
Write-Output 'Indexer Alpha stopped.'
