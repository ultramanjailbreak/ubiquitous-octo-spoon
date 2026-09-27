# hash.ps1 -- regenerate cache.appcache hashes after editing any cached file.
#
# The manifest carries a sha256 per entry so appcache sees a changed file as a
# new version. A stale hash means the console keeps serving the old loader out
# of its offline cache, which looks exactly like "my change did nothing". Run
# this after every edit to a cached file, then re-run tools/check.html.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root "cache.appcache"

# The CACHE section is everything before NETWORK:/FALLBACK:. Note the section is
# *implicit* -- this manifest has no "CACHE:" line -- so waiting for one before
# re-hashing means nothing is ever re-hashed and the script cheerfully reports
# "all current" against a manifest full of stale hashes.
$lines = Get-Content $manifest
$out = @()
$inCache = $true
$changed = @()
$rehashed = 0

foreach ($line in $lines) {
  if ($line -match '^\s*(NETWORK|FALLBACK):') { $inCache = $false; $out += $line; continue }
  if ($line -match '^\s*$') { $out += $line; continue }
  if ($line -match '^\s*#') { $out += $line; continue }
  if ($inCache -and $line -match '^(\S+)\s+#') {
    $rehashed++
    $rel = $Matches[1]
    $path = Join-Path $root ($rel -replace '/', '\')
    if (-not (Test-Path $path)) { Write-Warning "missing: $rel -- keeping old hash"; $out += $line; continue }
    $hash = (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower()
    $new = "$rel #$hash"
    if ($new -ne $line.Trim()) { $changed += $rel }
    $out += $new
    continue
  }
  $out += $line
}

# A script that re-hashes nothing is worse than no script, because it reports
# success. Say so loudly rather than implying the manifest is fine.
if ($rehashed -eq 0) {
  Write-Error "No CACHE entries were parsed from $manifest -- refusing to report success."
  exit 1
}

# Write UTF-8 with NO BOM. Appcache parses this file by hand and requires the
# first line to be exactly "CACHE MANIFEST" -- a UTF-8 BOM puts EF BB BF in
# front of it and the whole manifest is rejected as malformed, which silently
# drops the console back to online-only with nothing in the console log to say
# why. Set-Content -Encoding UTF8 emits a BOM on PowerShell 5.1, so write the
# bytes directly instead.
$text = ($out -join "`n") + "`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifest, $text, $utf8NoBom)

if ($changed.Count) {
  Write-Host "re-hashed $($changed.Count) of $rehashed entries:"
  $changed | ForEach-Object { Write-Host "  $_" }
} else {
  Write-Host "all $rehashed manifest hashes already current"
}

