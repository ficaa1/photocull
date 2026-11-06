# Security

## Reporting a vulnerability

Report it privately through [GitHub security advisories](https://github.com/ficaa1/photocull/security/advisories/new), rather than a public issue. Include the PhotoCull version, operating system, reproduction steps and impact. Use a minimal synthetic file where possible; do not attach private photographs or settings.

Fixes go into the latest release. Older versions are not maintained separately.

## Local data and boundaries

PhotoCull stores sessions, decisions, recipes, previews and settings locally. The renderer reaches the loopback backend through an authenticated bridge; native commands are allowlisted. Test instances must use an isolated `PHOTOCULL_DATA_DIR`.

Source images are read-only during culling and finished-image export. Copy export writes metadata only to destination copies. Source XMP autosave follows the configured policy: ordinary folders by default, recognized camera cards excluded. The source-XMP export command is explicit; disk deletion always requires confirmation. Treat image parsers, metadata, external editor paths and downloaded lens profiles as untrusted input.

Lensfun data downloads only on request. The external Dehancer plugin is separately installed. Installers are currently unsigned and macOS builds are not notarized. Check release provenance before installing.
