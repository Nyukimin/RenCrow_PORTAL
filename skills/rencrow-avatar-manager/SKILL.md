---
name: rencrow-avatar-manager
description: Manage RenCrow PORTAL PuruPuru avatars end to end. Use when adding a character, replacing or regenerating Mio/Shiro/Midori assets, syncing a .purupuru package, changing Chat or IdleChat avatar placement, rebuilding PORTAL, or verifying packaged, embedded, HTTP-served, and browser-rendered avatar assets.
---

# RenCrow Avatar Manager

Use the repository synchronizer as the implementation and this Skill as the
safe operational workflow. Do not make direct PORTAL asset copies the normal
source of truth.

## Start

1. Treat `RenCrow_PORTAL/skills/rencrow-avatar-manager` as the canonical,
   version-controlled Skill. If the auto-discovery junction is absent, run
   `scripts/install.ps1`.
2. Read `references/locations.json`.
3. Run:

```powershell
python "$env:USERPROFILE\.codex\skills\rencrow-avatar-manager\scripts\inspect_avatar.py" locations
python "$env:USERPROFILE\.codex\skills\rencrow-avatar-manager\scripts\inspect_avatar.py" inspect --all
```

4. Classify the request as an existing-character update, a new-character
addition, or a display-placement change.
5. Preserve unrelated worktree changes. Never run the all-character sync before
checking whether it would overwrite a non-target PORTAL asset difference.

## Update an existing character

1. Treat the configured `.purupuru` package as the durable source of truth.
2. If the user changed a loose PNG, require or perform a PuruPuru package
re-export before the normal sync. Do not silently copy the loose PNG into
PORTAL and call the update durable.
3. Inspect the target package and every non-target character. A target mismatch
is expected before sync; a non-target mismatch is a stop condition because the
current synchronizer resets all configured character directories.
4. Run the repository synchronizer from the configured PORTAL root:

```powershell
go run .\cmd\sync-purupuru -source C:\Users\nyuki\Documents\GenerativeAI\PuruPuruPNGTuber
```

5. Run `inspect --all` again. Require zero package-to-PORTAL mismatches.
6. Run `go test ./... -count=1`, `go vet ./...`, `git diff --check`, and a
temporary binary build.
7. Resolve the exact process listening on port 18791, stop only that process,
build `build\rencrow-portal.exe`, and restart it hidden.
8. Fetch the changed HTTP asset with cache disabled and compare its SHA-256 to
the embedded source file.
9. Reload the live PORTAL in a real browser. Require every configured runtime
to reach `ready`, then visually check transparency, layer placement, motion,
and the requested Chat/IdleChat arrangement.

## Add a character

Read `references/new-character.md` before editing. Require an explicit:

- lowercase runtime/CORE actor ID;
- display name and source package path;
- Chat eligibility;
- Chat placement;
- IdleChat participation and slot.

Do not infer a CORE recipient or IdleChat participant from the presence of an
asset package. Until the repository has a single generated character registry,
update every hard-coded boundary listed in the reference and test it.

## Change placement

Keep the current policy unless the user explicitly changes it:

- Chat: exactly one selected character, centered.
- IdleChat: Mio on the left and Shiro on the right.
- Midori: selectable single-character Chat placement; no implicit IdleChat slot.

Treat file placement and visual placement separately. Asset locations belong
to `references/locations.json`; scene placement belongs to PORTAL CSS and
conversation-state logic.

## Safety

- Never edit `runtime-app.js` directly; regenerate it through
  `internal/purupurusync`.
- Never run `sync-purupuru` after a direct generated-asset edit without first
  reporting that the package will overwrite it.
- Never leave backup images inside `internal/portal/web`; Go embeds that tree.
- Never claim success from file existence or HTTP 200 alone. Verify package
  references, hashes, tests, the rebuilt binary, and live browser state.
- Report the source package, changed files, package/served hashes, test results,
  listener PID, and URL.
