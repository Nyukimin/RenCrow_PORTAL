# Embedded PuruPuru renderer

This directory vendors the browser renderer from
[rotejin/PuruPuruPNGTuber](https://github.com/rotejin/PuruPuruPNGTuber).
The PuruPuru-derived code is licensed under Apache-2.0; the copied license is
in `LICENSE`, and repository-level attribution is in
`../../../../THIRD_PARTY_NOTICES.md`.

## License boundary

The following files contain PuruPuru-derived Apache-2.0 code:

- `app.js`, `index.html`, and `styles.css`: upstream source bodies (app.js also includes the reviewed state-linked feature-overlay extension) with the
  RenCrow_PORTAL attribution and modification notice added by
  `internal/purupurusync`;
- `runtime-app.js`: generated from `app.js` by `internal/purupurusync` and
  modified for the scoped multi-avatar runtime.

`runtime-host.js` and `runtime-host.css` are RenCrow_PORTAL integration code,
not PuruPuru-derived files. They remain under the root RenCrow_PORTAL MIT
License. `manifest.json`, package metadata, and the surrounding PORTAL code are
also RenCrow_PORTAL-specific unless a file-level notice says otherwise.

The PNG files below `assets/<character>/` are RenCrow character assets extracted
from the explicitly configured avatar packages. They are not covered by the
PuruPuru code attribution above. PuruPuru demo images, screenshots, icons,
fonts, and vendored MediaPipe files are intentionally not copied here.

The upstream source snapshot currently has no `NOTICE` file. A future sync must
check for a newly added upstream `NOTICE` and preserve any applicable contents.

## Runtime modifications

`runtime-app.js` wraps the full application in a scoped instance factory and
adds only:

- `character=mio|shiro|kuro|midori|lumina` package selection;
- scoped DOM, storage, boot and teardown boundaries;
- the upstream control-mode motion path, with PORTAL forcing mouse-follow off
  while preserving each package's idle-motion setting;
- optional page-pointer input mapped to the same virtual stage coordinates as
  the standalone PuruPuru canvas, inactive under the current PORTAL policy;
- real audio RMS input passed through the package's original mic gain and mouth
  response settings without changing pose;
- a shared PORTAL animation scheduler;
- suppression of the standalone OBS server connection in PORTAL mode.

`runtime-host.js` owns the multi-instance stage. It does not implement a second
renderer. The editor DOM remains in each scoped instance because the PuruPuru
application is kept intact, while the scoped host hides its controls. PORTAL
uses a dedicated transparent runtime mode and does not enter any standalone OBS
branch. The hidden upstream control dock keeps its virtual input boundary so
the original asymmetric pointer-response curve is preserved. `manifest.json`
records the upstream commit and SHA-256 hashes used for provenance checks.

Character assets are extracted from the pinned generated packages, not copied
from loose intermediate PNGs:

- `avatar-packages/Mio/Mio-refined-DRAFT.purupuru`
- `avatar-packages/Shiro/Shiro-finish-v2-STATIC-v1.purupuru`
- `avatar-packages/Kuro/Kuro-materials-v4-STATIC-v3.purupuru`
- `avatar-packages/Midori/Midori-independent-glasses-STATIC-v1.purupuru`
- `avatar-packages/Lumina/Lumina_overlay6_PATCHED_ONLY_STATIC_v01.purupuru`

Lumina is registered only for rendering. Its six state-linked brow/lash overlays are drawn above front hair, preserving the same face deformation path. CORE recipient selection, Chat participation and IdleChat placement are not enabled for Lumina. Durable package sources are stored in the repository avatar-packages directory; use the root README sync command.

Storage compatibility: the upstream storage literals and all four existing PORTAL characters retain their original ten localStorage keys and IndexedDB name. The existing scopedStorage(character) prefix remains unchanged. Only the Lumina runtime resolves these names with the feature-overlays-v1 suffix; it keeps its own localStorage prefix and independent IndexedDB name. No old data is deleted or migrated.
