# Third-party notices

## PuruPuru PNGTuber

Portions of RenCrow_PORTAL include software derived from PuruPuru PNGTuber.

Copyright 2026 masa

Licensed under the Apache License, Version 2.0.

Source:
https://github.com/rotejin/PuruPuruPNGTuber

License:
internal/portal/web/purupuru/LICENSE

Modifications:
Adapted for the scoped multi-avatar runtime used by RenCrow_PORTAL.

### License boundary

The PuruPuru-derived `app.js`, `index.html`, `styles.css`, and generated
`runtime-app.js` remain under Apache-2.0. RenCrow_PORTAL-specific host and
integration code, including `runtime-host.js` and `runtime-host.css`, remains
under RenCrow_PORTAL's root MIT License.

The PNG files under `internal/portal/web/purupuru/assets/<character>/` are
RenCrow character assets extracted from the explicitly configured avatar
packages. They are not included in the PuruPuru-derived code license scope.
PuruPuru demo images, screenshots, icons, fonts, and vendored MediaPipe files
are not included in RenCrow_PORTAL.

The upstream PuruPuru source snapshot currently has no `NOTICE` file, so there
is no upstream NOTICE content to inherit. A future PuruPuru update must check
for a newly added `NOTICE` before it is distributed.
