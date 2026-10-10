param(
    [switch]$Compare,
    [switch]$NoOpen,
    [ValidateRange(1024, 65535)]
    [int]$Port = 4183
)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$previewUrl = "http://127.0.0.1:$Port/"
$manifestUrl = $previewUrl + 'preview-manifest.json'

function Test-OurPreview {
    try {
        # Use an ASCII identity, not the title: Windows PowerShell 5.1 can
        # decode UTF-8 HTML without a charset header as a legacy code page.
        $response = Invoke-WebRequest -Uri $manifestUrl -UseBasicParsing -TimeoutSec 2
        $manifest = $response.Content | ConvertFrom-Json
        return ($manifest.project -eq 'gundam-archive-v2')
    } catch {
        return $false
    }
}

if (-not (Test-OurPreview)) {
    $existingListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($existingListener) {
        throw "Port $Port belongs to a different service. That service has been left running."
    }
    $buildDirectory = Join-Path $projectDirectory 'dist'
    if (-not (Test-Path -LiteralPath (Join-Path $buildDirectory 'index.html')) -or
        -not (Test-Path -LiteralPath (Join-Path $buildDirectory 'preview-manifest.json'))) {
        throw 'Preview build is missing. Run npm install and npm run build in this folder first.'
    }
    $python = Get-Command python.exe -ErrorAction Stop
    $previewArguments = @('-m', 'http.server', [string]$Port, '--bind', '127.0.0.1', '--directory', ('"' + $buildDirectory + '"'))
    $server = Start-Process -FilePath $python.Source -ArgumentList $previewArguments -WorkingDirectory $projectDirectory -WindowStyle Hidden -PassThru
    $previewReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-OurPreview) { $previewReady = $true; break }
        $server.Refresh()
        if ($server.HasExited) { throw "Preview server exited with code $($server.ExitCode)." }
        Start-Sleep -Milliseconds 200
    }
    if (-not $previewReady) { throw 'Preview server did not respond. Verify Python is available.' }
}

$targetUrl = if ($Compare) { $previewUrl + 'compare.html' } else { $previewUrl }
Write-Output "Preview ready: $targetUrl"
if (-not $NoOpen) { Start-Process $targetUrl }

