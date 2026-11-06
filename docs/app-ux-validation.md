# Commands, settings and backup validation

The [workspace guide](workspace.md) describes the user workflow. Automated checks use generated photos, temporary app data and mocked camera volumes; no physical card is required.

## Coverage

- `npm test` covers shortcut conflicts, settings validation/import rollback, backup corruption detection, cancellation/resume, conflicts, links and changed files.
- `node scripts/workspace-ui-smoke.cjs` covers palette keyboard operation and filename search, customized Help, import preview/backup, Welcome choices, menu focus and complete/changed-card status.
- `npm run test:ui`, Develop and settings smokes cover the shared renderer and backend. See [validation](validation.md) for fixture-dependent arguments.
- Native logging and shell integration require `cargo fmt --check`, `cargo test --locked` and `cargo build --locked` on a supported build platform.

## Backup measurement

On a WSL host, a temporary 64 MiB file took 263.8 ms for one SHA-256 read (about 243 MiB/s), and 1864.4 ms for copying plus repeated source/destination verification. This is a cached local-filesystem measurement, not SD-card throughput.

## Limits

Browser smokes do not validate native dialogs, clipboard permissions, webviews or real-card throughput. Native macOS launch remains unverified. Settings bundles may include metadata and paths; review them before sharing. A verified-backup badge describes the last check, so changed storage needs another complete hash check before formatting outside PhotoCull.
