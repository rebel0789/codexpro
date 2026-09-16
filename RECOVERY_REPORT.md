# CodexPro Recovery Report

Date: 2026-09-16

This recovery branch was restored from `main`, reviewed against the live GitHub issue and pull-request queue, and verified locally before publication.

## Implemented

- Fixed `apply_patch` false positives when Git skips a nested-repository patch.
- Added bounded Codex transcript search and read-around tools, available only in `CODEXPRO_CODEX_SESSIONS=read`.
- Made search backend selection visible and made `max_results` apply to ripgrep correctly.
- Made self-test write probes restore or remove their temporary file, and decoupled Pro-context checks from write probes.
- Aligned the Bash timeout schema with the 15-minute server ceiling.
- Added connector request IDs and health diagnostics for authentication, dispatch, response, and error timing.
- Removed permissive CORS behavior, added same-origin admin protection and security headers, and preserved cross-session explicit workspace IDs.
- Added default absolute-path redaction with an explicit `CODEXPRO_EXPOSE_ABSOLUTE_PATHS=1` escape hatch.
- Made path-scoped Git operations resolve the nearest allowed repository and added stats-only diffs that do not materialize large raw diffs.
- Added Windows output decoding for UTF-16 and high-confidence legacy encodings.
- Added explicit Windows Bash runtime selection: `auto` prefers Git for Windows and never silently selects WSL; WSL requires `CODEXPRO_BASH_RUNTIME=wsl`.
- Made dedicated Git follow the selected Git-for-Windows installation when possible, and added Bash/Git/toolchain diagnostics to self-test.
- Hardened local handoff receipts around interruption, orphan detection, reconciliation, and default remote-mutation blocking.
- Documented the maintainer security contact and security-advisory route.

## Verification

`npm run release:check` passed on this branch, including:

- TypeScript build
- analysis, CLI, encoding, MCP, HTTP, widget, Pro, doctor, settings, handoff, and release smoke tests
- stress tests
- `npm audit --audit-level=high` with 0 vulnerabilities
- npm package dry-run for `codexpro@0.30.0`

## Scope notes

- `view_image` was already present in the restored `main` branch; issue #127 is covered by the existing implementation.
- GitHub private vulnerability reporting did not remain enabled through the repository API for this public repository, so `SECURITY.md` now names the maintainer and links to the advisory form.
- ChatGPT/Plugins service behavior in issues #65 and #93, and repeated client-side approval prompts in #71, require changes in the external client; CodexPro now exposes clearer diagnostics but cannot change that service behavior.
- Optional third-party `ffgrep`/CodeGraph integration in issue #33 remains intentionally unbundled and is not included in this recovery patch because it needs a separate compatibility and security design.
