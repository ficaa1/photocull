# Working on PhotoCull

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Every comment describes the code as it stands, without review rounds, issue IDs, plan sections or release labels.

## Comments

Keep them to a minimum. Say it in the code first: a good name needs no comment. Comment only a reason, constraint or trap the code cannot express. One line where one line will do. Never tell history; that belongs in the commit message.

## Tests

A test earns its place by catching a regression a reader would care about. Before adding one, identify the observable behavior, the code change that would make it fail, and whether an existing test already owns it.

- One owner per behavior: extend cases instead of duplicating coverage.
- Test through the entry points the app calls, with realistic setup.
- Add no production accessors, options or rendering paths solely for tests.
- Delete unreachable code with its tests.
- Compare against independent expected values. Prove regression tests fail when the guarded behavior is broken.
- Use synthetic fixtures and temporary state; no external network or personal photo paths.

## Project boundaries

The Tauri shell owns windows, native dialogs, deletion, Develop and finished-image encoding. The Node sidecar owns scanning, previews, decisions and copy planning. The plain JavaScript renderer uses its bridge only; preserve the Rust renderer method allowlist.

Never overwrite a source or camera-card image. Metadata writes belong on destination copies unless the user explicitly requests source XMP publication. Keep Lensfun data as an opt-in runtime download with attribution, never a bundled database.

Preserve upstream notices and the offline license inventory. Do not enable workflows or change repository visibility without explicit authorization.

## Before pushing

Run `npm test` and relevant UI smokes, regenerate notices offline, and run `cargo fmt --check`, `cargo test --locked` and `cargo build --locked` on a supported native build platform. Packaging changes also require `npm run build`. Report platform limits plainly.
