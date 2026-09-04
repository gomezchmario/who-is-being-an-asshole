# Backup trigger for the market scan: GitHub's cron scheduler silently drops
# runs, so a local scheduled task calls this every 30 minutes while the PC is
# on. Skips when a run already happened recently (e.g. the cron DID fire).
$repo = "gomezchmario/who-is-being-an-asshole"
$gh = "$env:LOCALAPPDATA\Microsoft\WinGet\Links\gh.exe"
if (-not (Test-Path $gh)) { $gh = "gh" }

try {
  $last = & $gh run list -R $repo --workflow=update-market.yml --limit 1 --json createdAt --jq '.[0].createdAt' 2>$null
  if ($last) {
    $age = (Get-Date).ToUniversalTime() - [DateTimeOffset]::Parse($last).UtcDateTime
    if ($age.TotalMinutes -lt 25) { exit 0 }
  }
  & $gh workflow run update-market.yml -R $repo 2>$null
} catch {}
