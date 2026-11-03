# The parent shell decodes this process's stdout with its own code page.
# Read node as UTF-8 strings, then emit the code page the parent will use.
$orig = [Console]::OutputEncoding
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$lines = @(& node "$PSScriptRoot\bin\orca-helm.mjs" @args)
$code = $LASTEXITCODE

$forceUtf8 = $env:ORCA_HELM_ENCODING -eq 'utf8'
$redirected = $false
try { $redirected = [Console]::IsOutputRedirected } catch { $redirected = $false }
if ($redirected -and -not $forceUtf8) {
  [Console]::OutputEncoding = $orig
}

if ($lines.Count -gt 0) {
  if ($redirected) {
    # shortcut: this bypasses the pipeline, so `$o = .\orca-helm.ps1` inside a redirected host captures nothing
    # (Write-Output here turns 5.1 -File output into UTF-8); upgrade by decoding node's stdout without [Console]::OutputEncoding.
    foreach ($line in $lines) { [Console]::Out.WriteLine($line) }
  } else {
    foreach ($line in $lines) { Write-Output $line }
  }
}

if ($null -eq $code) { $code = 1 }
exit $code
