/**
 * Vendored `dsh-log-contract` — the log-contract guard retrace validates marker
 * writes against, carried **inside this package** instead of resolved from the
 * registry.
 *
 * Why: retrace's pre-write guard is fail-closed. It replays the *entire* session
 * log through `createPreWriter(...).validateAppend(...)`, so any error-level
 * violation anywhere in the log rejects the write outright. The published
 * `dsh-log-contract` line is written against session format v<b>3</b>; on a host
 * that writes format v<b>4</b> (DSH Desktop 0.2.x) three of its rules fire on
 * every session — `system/message` must carry a `plugin` source (v4 uses
 * `system-prompt`), `tool/result` must be a `role: 'user'` message holding one
 * `tool-result` block (v4 uses `role: 'tool'` with a direct content array), and
 * the surface-type set lacks `developer/message` — which made every edit,
 * recall, regenerate and restore fail with `marker-rejected` and write nothing.
 *
 * `vendor/dsh-log-contract` is 0.3.18 with those three rules made
 * version-aware, plus the format-version set, migration target and support
 * baseline updated for v4 (see PATCH-NOTES.md). Importing it through this
 * relative shim — rather than the bare specifier `dsh-log-contract` — is what
 * makes the package self-contained: a plain `dsh plugin add <spec>` or
 * `npm`/`pnpm add` needs no `overrides` entry in the consuming profile.
 *
 * Only the package root entry is used (`exports["."]` → `lib/index.js`);
 * every consumer here wants named exports, so `export *` is enough.
 */
export * from '../vendor/dsh-log-contract/lib/index.js'