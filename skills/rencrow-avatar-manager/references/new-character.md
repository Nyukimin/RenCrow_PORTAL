# New character boundaries

Before adding a character, define its actor ID, display name, `.purupuru`
package, CORE recipient support, Chat placement, and IdleChat participation.

Update and test these current hard-coded boundaries:

- `internal/purupurusync/sync.go`
  - `Characters`
  - `CharacterPackages`
- `internal/purupurusync/sync_test.go`
  - package extraction and generated-runtime expectations
- `internal/portal/web/purupuru/runtime-host.js`
  - accepted character IDs
- generated `runtime-app.js`
  - regenerate through `TransformApp`; do not hand edit
- `internal/portal/web/index.html`
  - `<purupuru-avatar>` host and Chat selector when applicable
- `internal/portal/web/portal.js`
  - actor normalization, labels, recipients, speaking input, and state
- `internal/portal/web/portal.css`
  - single-Chat and explicitly configured IdleChat placement
- `internal/portal/server_test.go`
  - markup, runtime count, actor contract, and layout policy
- root `README.md`
  - source package and runtime mapping
- this Skill's `references/locations.json`

Adding a visual package does not automatically authorize the character as a
CORE Chat recipient. Keep visual-only and RenCrow-agent additions distinct.
