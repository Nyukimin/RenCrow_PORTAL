$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($env:TEMP)) {
    throw "TEMP must be set by scripts/test-local.ps1"
}
$destination = Join-Path $env:TEMP "release-layout"
$puruPuruRoot = Join-Path $repoRoot "internal\portal\web\purupuru"

$apacheMarkers = @(
    "SPDX-License-Identifier: Apache-2.0",
    "PuruPuru PNGTuber",
    "Copyright 2026 masa",
    "Licensed under the Apache License, Version 2.0.",
    "Source: https://github.com/rotejin/PuruPuruPNGTuber",
    "Modified for RenCrow_PORTAL; derived from PuruPuru PNGTuber."
)
foreach ($relative in @("app.js", "index.html", "styles.css", "runtime-app.js")) {
    $text = Get-Content -LiteralPath (Join-Path $puruPuruRoot $relative) -Raw
    foreach ($marker in $apacheMarkers) {
        if (-not $text.Contains($marker)) {
            throw "$relative is missing PuruPuru license marker: $marker"
        }
    }
}

$runtimeText = Get-Content -LiteralPath (Join-Path $puruPuruRoot "runtime-app.js") -Raw
if (-not $runtimeText.Contains("Generated from upstream app.js by internal/purupurusync. Do not edit by hand.")) {
    throw "runtime-app.js is missing its generated-file notice"
}
foreach ($relative in @("runtime-host.js", "runtime-host.css")) {
    $text = Get-Content -LiteralPath (Join-Path $puruPuruRoot $relative) -Raw
    foreach ($marker in @("SPDX-License-Identifier: Apache-2.0", "Copyright 2026 masa")) {
        if ($text.Contains($marker)) {
            throw "$relative is RenCrow_PORTAL MIT code but contains: $marker"
        }
    }
}

$rootLicense = Get-Content -LiteralPath (Join-Path $repoRoot "LICENSE") -Raw
if (-not $rootLicense.StartsWith("MIT License") -or -not $rootLicense.Contains("Copyright (c) 2026 Nyukimin")) {
    throw "root LICENSE must remain the RenCrow_PORTAL MIT License"
}

$notices = Get-Content -LiteralPath (Join-Path $repoRoot "THIRD_PARTY_NOTICES.md") -Raw
foreach ($marker in @(
    "## PuruPuru PNGTuber",
    "Copyright 2026 masa",
    "https://github.com/rotejin/PuruPuruPNGTuber",
    "internal/portal/web/purupuru/LICENSE",
    "Adapted for the scoped multi-avatar runtime used by RenCrow_PORTAL.",
    "currently has no ``NOTICE`` file",
    "``runtime-host.js`` and ``runtime-host.css``"
)) {
    if (-not $notices.Contains($marker)) {
        throw "THIRD_PARTY_NOTICES.md is missing: $marker"
    }
}
if (Test-Path -LiteralPath (Join-Path $puruPuruRoot "NOTICE") -PathType Leaf) {
    throw "the current vendored PuruPuru snapshot unexpectedly contains NOTICE; review and inherit it before release"
}

$manifest = Get-Content -LiteralPath (Join-Path $puruPuruRoot "manifest.json") -Raw | ConvertFrom-Json
$manifestHashes = @{}
foreach ($property in $manifest.files.PSObject.Properties) {
    $manifestHashes[$property.Name] = ([string]$property.Value).ToLowerInvariant()
}
$fontExtensions = @(".eot", ".otf", ".ttf", ".woff", ".woff2")
$imageExtensions = @(".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp")
$characters = @("Kuro", "Midori", "Mio", "Shiro")
$imageCount = 0
foreach ($file in Get-ChildItem -LiteralPath $puruPuruRoot -Recurse -File) {
    $relative = $file.FullName.Substring($puruPuruRoot.Length + 1).Replace("\", "/")
    $segments = @($relative.Split("/"))
    foreach ($segment in $segments) {
        if ($segment -in @("demo-avatar", "demo-avatar02", "demo-avatar03", "font", "fonts", "icon", "icons", "image", "images", "screenshot", "screenshots", "vendor")) {
            throw "PuruPuru upstream media/vendor directory must not be bundled: $relative"
        }
    }
    $extension = $file.Extension.ToLowerInvariant()
    if ($extension -in $fontExtensions) {
        throw "font must not be bundled in the PuruPuru subtree: $relative"
    }
    if ($extension -notin $imageExtensions) {
        continue
    }
    $imageCount++
    if ($extension -ne ".png" -or $segments.Count -lt 3 -or $segments[0] -ne "assets" -or $segments[1] -notin $characters) {
        throw "only configured RenCrow avatar-package PNGs may be bundled: $relative"
    }
    if (-not $manifestHashes.ContainsKey($relative)) {
        throw "avatar PNG is missing from the provenance manifest: $relative"
    }
    $actualHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $manifestHashes[$relative]) {
        throw "avatar PNG hash does not match the provenance manifest: $relative"
    }
}
if ($imageCount -eq 0) {
    throw "asset audit did not inspect any configured RenCrow avatar PNGs"
}

& (Join-Path $repoRoot "scripts\build.ps1") -OutputDirectory $destination
if ($LASTEXITCODE -ne 0) {
    throw "scripts/build.ps1 failed with exit code $LASTEXITCODE"
}

$expected = @{
    "LICENSE" = "LICENSE"
    "THIRD_PARTY_NOTICES.md" = "THIRD_PARTY_NOTICES.md"
    "licenses/PuruPuruPNGTuber-Apache-2.0.txt" = "internal/portal/web/purupuru/LICENSE"
}
foreach ($relative in $expected.Keys) {
    $staged = Join-Path $destination ($relative.Replace("/", [IO.Path]::DirectorySeparatorChar))
    $source = Join-Path $repoRoot ($expected[$relative].Replace("/", [IO.Path]::DirectorySeparatorChar))
    if (-not (Test-Path -LiteralPath $staged -PathType Leaf)) {
        throw "release layout is missing $relative"
    }
    $stagedHash = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    if ($stagedHash -ne $sourceHash) {
        throw "release layout file does not match its source: $relative"
    }
}

$binary = Join-Path $destination "rencrow-portal.exe"
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw "release layout is missing rencrow-portal.exe"
}

$apacheText = Get-Content -LiteralPath (Join-Path $destination "licenses/PuruPuruPNGTuber-Apache-2.0.txt") -Raw
foreach ($marker in @(
    "Copyright 2026 masa",
    "Apache License",
    "Version 2.0, January 2004",
    "END OF TERMS AND CONDITIONS"
)) {
    if (-not $apacheText.Contains($marker)) {
        throw "staged Apache license is missing: $marker"
    }
}

Write-Host "[OK] Release binary and license layout passed"
