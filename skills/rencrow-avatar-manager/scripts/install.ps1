$ErrorActionPreference = "Stop"

$canonicalSkill = [System.IO.Path]::GetFullPath(
    (Split-Path -Parent $PSScriptRoot)
).TrimEnd("\")

$codexRoot = if ($env:CODEX_HOME) {
    [System.IO.Path]::GetFullPath($env:CODEX_HOME)
} else {
    [System.IO.Path]::GetFullPath(
        (Join-Path $env:USERPROFILE ".codex")
    )
}

$skillsRoot = Join-Path $codexRoot "skills"
$installedSkill = Join-Path $skillsRoot "rencrow-avatar-manager"
New-Item -ItemType Directory -Path $skillsRoot -Force | Out-Null

if (Test-Path -LiteralPath $installedSkill) {
    $existing = Get-Item -LiteralPath $installedSkill -Force
    if ($existing.LinkType -eq "Junction") {
        $existingTarget = [System.IO.Path]::GetFullPath(
            [string]$existing.Target
        ).TrimEnd("\")
        if ($existingTarget -ieq $canonicalSkill) {
            Write-Output "Skill junction already configured: $installedSkill -> $canonicalSkill"
            exit 0
        }
    }
    throw "Refusing to replace existing Skill path: $installedSkill"
}

New-Item `
    -ItemType Junction `
    -Path $installedSkill `
    -Target $canonicalSkill | Out-Null

Write-Output "Installed Skill junction: $installedSkill -> $canonicalSkill"
