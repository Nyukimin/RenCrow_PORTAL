# PORTAL avatar package sources

These packages are the durable source of truth. Keep delivered PNG bytes, coordinates and layer settings unchanged.

Mio-refined-DRAFT repackages the existing refined ZIP and provisional settings without regeneration; its rig and real-app behavior remain unverified. Shiro, Kuro v3 and Midori retain their validated package bytes. Lumina retains the six-state feature-overlay extension and remains visual-only until CORE recipient eligibility and scene participation are explicitly configured.

Synchronize from the PORTAL root:

go run ./cmd/sync-purupuru -source internal/portal/web/purupuru -packages avatar-packages -source-commit 9dc1e735155faae8f54f9ee3076b52db7da36624

Do not run the older external-source sync command over the reviewed Lumina runtime.
