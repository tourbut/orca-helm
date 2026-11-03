# node writes stdout to a temp file as UTF-8 (ORCA_HELM_STDOUT_FILE) and this script reads it back.
# Decoding a pipe would mean changing [Console]::OutputEncoding, after which Windows PowerShell 5.1
# writes this script's own output as UTF-8 too. Lines go out through the pipeline, so the host encodes
# them for the parent and `$o = .\orca-helm.ps1 ...` captures them even when the host is redirected.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$tmp = [IO.Path]::GetTempFileName()
$prevFile = $env:ORCA_HELM_STDOUT_FILE
$env:ORCA_HELM_STDOUT_FILE = $tmp
$code = $null
$text = ''
try {
  & node "$PSScriptRoot\bin\orca-helm.mjs" @args
  $code = $LASTEXITCODE
  $text = [IO.File]::ReadAllText($tmp, (New-Object System.Text.UTF8Encoding $false))
} finally {
  $env:ORCA_HELM_STDOUT_FILE = $prevFile
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}

$orig = [Console]::OutputEncoding
try {
  # The console code page is shared with the parent, so put it back after writing.
  if ($env:ORCA_HELM_ENCODING -eq 'utf8') {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  }
  if ($text.Length -gt 0) {
    ($text -replace '\r?\n\z', '') -split '\r?\n'
  }
} finally {
  if ([Console]::OutputEncoding.CodePage -ne $orig.CodePage) { [Console]::OutputEncoding = $orig }
}

if ($null -eq $code) { $code = 1 }
exit $code
