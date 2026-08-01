param(
    [string]$OutputDirectory = "build"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputPath = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
    [IO.Path]::GetFullPath($OutputDirectory)
} else {
    [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
}

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
$binaryPath = Join-Path $outputPath "rencrow-portal.exe"

Push-Location $repoRoot
try {
    & go build -o $binaryPath ./cmd/rencrow-portal
    if ($LASTEXITCODE -ne 0) {
        throw "go build failed with exit code $LASTEXITCODE"
    }

    & go run ./cmd/stage-release-licenses -destination $outputPath
    if ($LASTEXITCODE -ne 0) {
        throw "license staging failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

Write-Host "[build] release layout: $outputPath"
