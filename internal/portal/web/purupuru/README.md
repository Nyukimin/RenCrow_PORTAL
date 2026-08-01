# Embedded PuruPuru renderer

This directory vendors the browser renderer from
[rotejin/PuruPuruPNGTuber](https://github.com/rotejin/PuruPuruPNGTuber).
The PuruPuru-derived code is licensed under Apache-2.0; the copied license is
in `LICENSE`, and repository-level attribution is in
`../../../../THIRD_PARTY_NOTICES.md`.

## License boundary

The following files contain PuruPuru-derived Apache-2.0 code:

- `app.js`, `index.html`, and `styles.css`: upstream source bodies with the
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

- `character=mio|shiro|kuro|midori` package selection;
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

- `Mio/Mio.purupuru`
- `Shiro/Shiro02.purupuru`
- `Kuro/Kuro.purupuru`
- `Midori/Midori02.purupuru`
