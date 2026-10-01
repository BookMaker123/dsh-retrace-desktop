# dsh-retrace — Desktop-patched build (`0.4.32-desktop.3`)

Locally patched copy of **dsh-retrace 0.4.32** (npm) that loads and runs on
**DSH 0.2.x — including DSH Desktop 0.2.0-rc.2** (`@deepseek-ai/dsh 0.2.0-rc.2`,
session format **v4**), plus a vendored, locally patched **dsh-log-contract
0.3.18** that retrace's pre-write guard depends on.

Upstream 0.4.32 targets the 0.1.x runtime line (`^0.1.0-rc.6` peers), so DSH
Desktop's compatibility gate rejects it:

```
dsh: installation rejected: Plugin dsh-retrace@0.4.32 is incompatible with dsh 0.2.0-rc.2:
peerDependencies {... ^0.1.0-rc.6 ...}. … dsh: nothing was installed.
```

Since `0.4.32-desktop.3` the patched contract travels **inside** this package
(`vendor/dsh-log-contract`, imported through `lib/vendor-contract.js`), so the
package is self-contained: a plain `file:`, git, or registry install needs no
`overrides` entry in the consuming profile.

Both halves are installed into the `desktop` profile by
[`install-into-desktop.ps1`](install-into-desktop.ps1) — run it after any change
in this directory. The plugin source lives here; the profile only ever holds a
copy (see *Reinstalling* below). To publish, see *Packaging & distribution*.

## Changes against upstream 0.4.32

### 1. `package.json` — peer ranges widened to the 0.2.x line

Every gated peer moved from `^0.1.0-rc.6` to `>=0.1.0-rc.6 <0.3.0`
(`@deepseek-ai/dsh-session`, `dsh-token-meter`, `dsh-storage-domain`,
`dsh-client-locale`, `dsh-client-ui-conversation`, `dsh-client-ui-slots`).
`@deepseek-ai/cordis` and `react` are not gated and were left alone.
`version` is `0.4.32-desktop.3` so the patched build is distinguishable.

The gate only inspects peers named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`
(`evaluatePluginCompatibility` in `@deepseek-ai/dsh-app-boot`). An
incompatible **bundle** is skipped silently and an incompatible **row** is
denied with `dsh: disabling profile plugin …`, so widening the ranges is
mandatory — installing by hand does not bypass it.

### 2. Session format v4 — compaction checkpoint vocabulary

v4 retired the generic plugin wrapper as a message source and introduced a
producer-owned kind:

| | source |
|---|---|
| v0–v3 | `{ kind: 'plugin', plugin: 'compact' }` |
| v4 | `{ kind: 'compact-checkpoint' }` |

The v3→v4 upgrade maps `plugin`/`compact` → `compact-checkpoint`
(`session-format-v3-to-v4/src/message-sources.ts`), and v4 admission refuses
`kind === 'plugin'` outright, so a v4 host can never emit the old shape again.
Upstream retrace only recognized the old shape, which would have made every
checkpoint look like real user input (recall/edit affordances on a checkpoint,
wrong round boundaries).

`isCompactCheckpoint` / `isCompactCheckpointSource` now accept **both**, so
pre-upgrade and post-upgrade logs behave identically:

```js
if (!source || typeof source !== 'object') return false
if (source.kind === 'compact-checkpoint') return true
return source.kind === 'plugin' && source.plugin === 'compact'
```

Patched in every copy of the predicate — the sources **and** their built twins,
because the renderer loads the bundle, not `client.js`:

| file | why |
|---|---|
| `lib/client.js` | source of the client half |
| `lib/client.bundle.js` | what `exports["./client"]` serves to the renderer |
| `lib/dynamic-client.js` | generated twin of the client half |
| `lib/version-index.js` | host half (`isCompactCheckpointSource`); `lib/dynamic-host.js` inlines only the writer/host-core region and has no copy of this predicate |

### 3. ★ The blocker: `dsh-log-contract` rejected **every** write on a v4 session

This was invisible until the plugin could actually load. retrace validates each
marker write *fail-closed* before touching the log:

```
lib/prewrite-guard.js:202-214
  const prewriter = factory({ events: [...sessionEvents(session), audit], header: session.header })
  verdict = prewriter.validateAppend(envelope)
  if (!verdict?.ok) throw editorError('marker-rejected', …)
```

`validateAppend` re-runs the whole rule set over **the entire session log**
(`prewrite.js:208-226` → `runChecks([...events, candidate])`), and
`dsh-log-contract` 0.3.17 was written against session format 3. Three of its
rules fire on *every* v4 session, so edit / recall / regenerate / restore were
all rejected with `marker-rejected` and nothing ever reached disk:

| rule | file:line | v3 expectation | v4 reality |
|---|---|---|---|
| **E9** | `checks.js:144` | `system/message` `source.kind === 'plugin'` | producer-owned `kind: 'system-prompt'`; v4 refuses `plugin` |
| **E6** | `checks.js:125,148-158` | `tool/result` role `'user'` + exactly one `tool-result` wrapper block | role `'tool'`, direct content array, `message.toolCallId === source.callId` |
| **S2/S4** | `checks.js:15-23` | surface types = user/assistant/tool (+ `system/message` from v3) | v4 adds `developer/message`, which always carries `surfaceOp` |

Measured on a real v4 session log (`~/.dsh/sessions/--D-tmp--/session-309c7063…`),
through the *installed* plugin's own guard, before the fix — 0 of 40 legitimate
replace spans validated, each blocked by E9 (×1) and E6 (×116) over the log.
After the fix, the same spans validate and a genuinely invalid span is still
rejected with `S4`/`S8`.

A census of **all 19 v4 session logs** on this machine (10,251 events) shows how
universal the blockers were — and that B3 is not hypothetical:

| event / source | count | pre-patch rule that fired |
|---|---|---|
| `system/message` / `system-prompt` | 44 | E9, one per session that has one |
| `tool/result` / `tool` | 1880 (2 per tool call) | E6 (`role must be "user"`, `must contain one tool-result block`) |
| `developer/message` / `tool-registry` | 1 | S2 (`surfaceOp` on a type outside the set) |

That single `developer/message` (session-38be125c, seq 286) is exactly the shape
the official v4 set admits: `surfaceOp: "append"`, role `developer`, source
`tool-registry`, `content: [{ type: 'tool-removal' }]`.

### 4. Vendored `dsh-log-contract` 0.3.18 (`vendor/dsh-log-contract`)

`dsh-log-contract` is retrace's own dependency, but it is not a bundle and its
peer (`@deepseek-ai/dsh-session`) is not a `dsh*` name, so the compatibility gate
never looks at it — it silently ran with v3 semantics. It is therefore patched
and carried **in this package**:

* `vendor/dsh-log-contract/` — the patched copy (version bumped to `0.3.18` +
  `dshDesktopPatch` marker, so it is identifiable at runtime);
* `lib/vendor-contract.js` — the single re-export shim every consumer imports
  (`export * from '../vendor/dsh-log-contract/lib/index.js'`), used by
  `lib/index.js`, `lib/archaeology-cli.js`, `lib/versioning.js`,
  `lib/prewrite-guard.js` (lazy `import()`), `lib/watchdog.js` (lazy `import()`)
  and `bin/retrace.mjs`. No bare `dsh-log-contract` specifier remains, and
  `dsh-log-contract` is no longer a registry dependency.

Until `0.4.32-desktop.2` this was instead pinned with a pnpm `overrides:` entry
in the profile's `pnpm-workspace.yaml`; that approach needed extra setup in every
consuming profile and could not survive a git/registry install, so it was
replaced. A profile that still carries the old pin is cleaned up by
`install-into-desktop.ps1` (it removes just that line and keeps other overrides).

| # | file | change |
|---|---|---|
| B1 | `lib/checks.js` | `messageShapeViolations` is now version-aware; for v4 `system/message` requires `source.kind === 'system-prompt'` (v0–v3 keep the plugin-wrapper rule) |
| B2 | `lib/checks.js` | v4 `tool/result`: role `'tool'`, no wrapper block, `message.toolCallId === source.callId`; v0–v3 unchanged. `developer/message` (role `'developer'`) admitted |
| B3 | `lib/checks.js` | `V4_SURFACE_TYPES` adds `developer/message`; `currentSurfaceTypes(version)` selects v0-2 / v3 / v4 sets |
| B6 | `lib/validate.js` | known `header.version` set `[0,1,2,3]` → `[0,1,2,3,4]` (H2 used to fire on every v4 file) |
| B7 | `lib/vocab.js` | `MIGRATION_TARGET_VERSION` derives from `HOST_MAX_FILE_VERSION` instead of a hardcoded 3 (0.2.0-rc.2 has a real `dsh-session-format-v3-to-v4` link) |
| B8 | `lib/version-support.js` | baseline is now host `0.2.0-rc.2` / format 4, so v4 files are no longer classified `unverified` + read-only by the CLI |
| B9 | `package.json` | peer `^0.1.0-rc.7 \|\| ^0.1.5-rc.1` → `>=0.1.0-rc.7 <0.3.0`; version `0.3.18` + `dshDesktopPatch` marker |
| — | `lib/contracts.js` | rule documentation for H2 / E6 / E9 / S1 / S4 now names the v4 shape and the 0/1/2/3/4 version set (the reported `source` strings used to say `0/1/2/3`) |

The offline `check` report on a real v4 log is clean apart from one **pre-existing,
platform-specific** false positive: H2 `header.cwd 若存在必须为绝对路径` fires on
every Windows session (`D:\…` does not start with `/`). It is identical on v3
logs, comes from the upstream rule's POSIX assumption, and retrace never calls
`validateSessionLog`, so it does not affect the plugin.

### 5. Retrace's own surface sets (five copies)

`lib/version-index.js:50`, `lib/client.js:417`, `lib/client.bundle.js:993`,
`lib/dynamic-client.js:999`, `lib/summary-gate.js:50` hardcoded the three-type
set `user/assistant/tool` (missing `system/message`, which is a surface type from
v3, and `developer/message`, new in v4). All five now match the official set
(`dsh-session@0.2.0-rc.2 lib/types/surface.js:13-19`):

```js
new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])
```

`lib/boundary-what.js` additionally learns the two new roles and their text
extraction (`ROLE_BY_TYPE`, `eventText`) so the boundary digest reports them
instead of `unknown` / empty.

## Verified against the real 0.2.0-rc.2 runtime

Two harnesses, both launched with the *bundled* runtime so the module graph is
exactly the one Desktop uses (`ELECTRON_RUN_AS_NODE=1` +
`…\DeepSeek Harness.exe`, `@deepseek-ai/*` resolved from `app.asar`):

* **isolated host boot** (`DSH_HOME=D:\tmp\dsh-test-home`, profile
  `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `dsh-retrace`):
  * `GET /api/plugins/retrace/status` → `{"ok":true,"value":null}` — host half
    imports, `apply()` runs, the `webServer` route is registered;
  * `GET /plugins/??dsh-retrace/client.js&rev=…` → the served bundle contains
    both patches; the boot HTML lists `dsh-retrace/client.js`, i.e. the client
    half is registered too.
* **composition dump** of the `desktop` profile → `# == dsh-retrace` present,
  no `skipp`/`denied`/`incompatible` line.
* **write-path probes** on real v4 session logs
  (`D:\tmp\v4-prewrite-probe.mjs`, `D:\tmp\v4-prewrite-sweep.mjs`,
  `D:\tmp\rt-guard-e2e.mjs`): with the unpatched contract 0/40 spans validated
  (E9+E6); with the patched contract valid spans validate, invalid ones are still
  rejected (`S4`/`S8`), and retrace's own gates (stale `auditSeq`, rollback
  guard) still fire. The same sweep over a **v3** log gives byte-identical
  results before and after the patch, so v0–v3 behaviour is unchanged.

* **packaged-artifact test** — `pnpm pack` then install the tarball into a scratch
  profile (no override, prod deps only): `node_modules/dsh-retrace` +
  `node_modules/zod` and nothing else, the vendored contract inside the copy, the
  isolated host boots, `GET /api/plugins/retrace/status` answers
  `{"ok":true,"value":null}`, and the **served** client bundle contains
  `new Set(["system/message","user/message","developer/message","assistant/message","tool/result"])`
  plus `if (source.kind === "compact-checkpoint") return true;` — i.e. the
  published artifact is the patched one.

## Unchanged / checked by hand

Everything else retrace 0.4.32 relies on still holds in 0.2.0-rc.2:

* host imports still exported: `deriveEventMessage`, `foldSurface`,
  `SESSION_FORMAT_VERSION`, `KNOWN_SESSION_EVENT_TYPES`,
  `isSurfaceEligibleType`, `adoptSessionEvent` (`dsh-session`),
  `defineDomain`, `domainTable` (`dsh-storage-domain`).
* surface op shape: `runtimeSurfaceOpShape()` keys off
  `SESSION_FORMAT_VERSION >= 3` → `{ op, startSeq, endSeq }` for v4. v4's
  `isReplaceOp` still requires exactly those three keys.
* retrace's carrier `user/message` payload `{ role, id, content, source }` is
  still the admitted v4 shape (`assertMessageEventShape`: for `user/message` the
  event `data` **is** the message).
* carrier `source.kind = 'model'` is admitted (only `plugin` is refused); v4
  also requires non-empty `provider`/`model`, which retrace copies from the
  session's last model header.
* `compaction/prune` payload is still exactly
  `{ shadowedRange, shadowedSeqs, shadowedTokenCount }`, with `shadowedSeqs`
  naming an exact current surface span — how retrace builds it.
* client surfaces exist unchanged: seats `conversation.chat.assistant-actions`,
  `conversation.chat.node`, `settings.general.item`; services `slots`, `locale`,
  `uiConversation`; `dsh.client.platform === "web"` is still what
  `dsh-client-modules` requires.
* `dsh-log-contract`'s imports of `@deepseek-ai/dsh-session` resolve to the
  **installation** copy inside `app.asar` (0.2.0-rc.2), not to the stale
  `~/.dsh/profiles/node_modules/@deepseek-ai/*` (0.1.5-rc.3), because
  `@deepseek-ai/dsh-app-boot` routes installation-scope names ahead of the
  profile's own `node_modules`.

## Packaging & distribution

The package is self-contained and publish-ready.

* **Contents** — `pnpm pack` produces ~70 files / ~520 KB
  (`dsh-retrace-0.4.32-desktop.3.tgz`): `lib/**`, `bin/retrace.mjs`,
  `vendor/dsh-log-contract/**`, `cordis.patch.yml`, both READMEs, `PATCH-NOTES.md`
  and both licenses. `node_modules`, build scripts and the upstream `scripts/`
  generators (absent from this copy) are not packed; `prepublishOnly` only runs
  syntax checks that exist here.
* **Profile requirements** — none beyond the plugin itself: peers come from the
  host installation, and the only runtime dependency is `zod`.
* **Install specs that work**
  * local directory — `dsh plugin --profile <p> add <this-directory>`
  * GitHub — `dsh plugin --profile <p> add "github:<owner>/dsh-retrace-desktop#main"`
  * tarball — `dsh plugin --profile <p> add <file>.tgz`
  * npm — needs a package name equal to the Cordis row name (see below)
* **Why not npm under this name** — `dsh-retrace` on npm belongs to the upstream
  authors. A git/tarball install keeps the package name `dsh-retrace`, which is
  what the bundle row imports (`cordis-plugin-loader/lib/index.js:451` imports
  `entry.name`; the row is `name: dsh-retrace`), so **no rename is needed**.
  Publishing to npm under a different name would require renaming the cordis row,
  `lib/index.js`/`lib/client.js` `name`, the embedded client-bundle id and the
  route keys in the same commit.
* **Publishing** — [`publish.ps1`](publish.ps1):
  `.\publish.ps1 -Owner <you> [-Repo dsh-retrace-desktop] [-Token ghp_…]` runs the
  checks, commits to `main`, creates the public GitHub repo with the
  `dsh-plugin` topic (with `-Token`) and pushes; without `-Token` it commits and
  prints the one push command. It then prints the listing checklist.
* **Marketplace** — the DSH ecosystem has no first-party upload API. Community
  hubs index **public repositories carrying the GitHub topic `dsh-plugin`**:
  [dsh-plugin.org](https://dsh-plugin.org/submit) (submit page; requires a public
  repo, the topic, a README with a copyable install command, an `apply(ctx)`
  export and a license), the
  [awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)
  list, and the in-app **dsh-market** (`dsh plugin --profile desktop add dshmarket`
  → Settings → Plugin Market), which searches the same catalog. Listing is
  automatic once the repo is public with the topic; `unconfirmed` until reviewed.

## Reinstalling / removing

* Reinstall / refresh: `install-into-desktop.ps1` (parameters `-Source`,
  `-InstallRoot`, `-ProfileDir`). It rewrites the `file:` dependency and the
  bundle entry, drops a stale `dsh-log-contract` override if one is present, then
  runs the bundled pnpm **twice** — once with the dependency removed, once with it
  restored. That two-pass dance is not cosmetic: pnpm materialises a `file:`
  **directory** dependency by *copying* it and reports `Already up to date`
  whenever only the directory's contents changed, leaving stale files in
  `node_modules`. It cannot be forced with `pnpm install --force` either. (A
  tarball or git spec has no such problem.)
* Remove: `uninstall-from-desktop.ps1`, then restart DSH Desktop.
* Never install retrace through Settings → Plugins **from npm**: it would fetch
  the unpatched upstream 0.4.32 (rejected as incompatible, and v3-only once
  forced in). Installing the GitHub/tarball build from there is fine.

## Caveats

* The profile manifest must stay **UTF-8 without BOM** — a BOM makes
  `readProfileManifest` fail and DSH Desktop refuses to boot
  (`Unexpected token '﻿' …`).
* A DSH Desktop upgrade changes the runtime version *and* the session format;
  re-check the peer ranges, the vendored contract's version constants
  (`HOST_MAX_FILE_VERSION` is read from the runtime, but `TESTED_BASELINE` and
  `KNOWN_FORMAT_VERSIONS` are written down) and `SESSION_FORMAT_VERSION` before
  restarting.
* The generated twins (`lib/client.bundle.js`, `lib/dynamic-client.js`) are
  edited by hand here; upstream's `pnpm build` would overwrite them with the
  same fixes only after porting `lib/client.js` (which is patched).