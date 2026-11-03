[Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
& node "$PSScriptRoot\bin\orca-helm.mjs" @args
exit $LASTEXITCODE
