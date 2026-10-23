# dsh-lineup-manager

**Pick which model lineups appear in DeepSeek Harness's model picker — grouped by provider, and refreshed live from each platform.**

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.2.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | All (plain ESM; no native code, no build toolchain) |

## The problem

DSH groups its model dropdown by provider, but how many entries show up depends on your config:

- a provider that **declares a `models:` list** in `cordis.patch.yml` → only those lineups appear
- a provider with **no `models:` list** → the picker shows the adapter's *entire* catalog, which can be hundreds of entries

So keeping only the free lineups means hand-editing YAML. This plugin turns that into checkboxes in Settings.

Platforms change their lineup every few days — new models appear, free tiers vanish. Refresh pulls the live list and marks the difference, so you can see what moved without leaving the panel.

## Features

- Per-provider checkboxes for every declared lineup
- Bulk per provider: **All** / **None** / **Free only**
- **Refresh** — pulls the platform's current lineup list and flags **new** and **gone** entries. Available per provider and as **Refresh all**
- Live-added models become selectable immediately, before they exist in your config
- Writes are surgical and reversible: only the target provider's `models:` block is replaced, with a timestamped backup, a structural check, and a read-back verification that rolls back on mismatch

## Install

### From a tarball (recommended)

```sh
pnpm pack                       # produces dsh-lineup-manager-<version>.tgz
dsh plugin add ./dsh-lineup-manager-0.2.0.tgz
```

Restart DSH afterwards.

### From a git checkout

```sh
dsh plugin add github:<you>/dsh-lineup-manager
```

The `prepare` script builds `dist/` on install. pnpm >=10 refuses to run git dependencies' build scripts by default; if the first `add` fails, add this to the profile's `pnpm-workspace.yaml` and retry:

```yaml
allowBuilds:
  dsh-lineup-manager: true
```

Only allow this for sources you trust, and pin a commit: `github:<you>/dsh-lineup-manager#<sha>`.

### Manual

```sh
pnpm install
pnpm build                     # emits dist/ and verifies it
```

Then copy the package into `$DSH_HOME/profiles/<profile>/node_modules/` and restart DSH.

## Usage

1. Open **Settings → the "Lineups" button at the top**
2. The panel lists every provider in your `cordis.patch.yml` with a checkbox per lineup
3. Per provider, use **All** / **None** / **Free only**, then **Save** that group
4. **Restart DSH** for the model picker to reflect the change

Unsaved changes are flagged; closing the panel asks for confirmation.

### Refresh

Press **Refresh** on a provider (or **Refresh all** in the footer) to pull that platform's current list:

- a green **new** badge = the platform offers it, you have not checked it
- a struck-through grey **gone** badge = you checked it, the platform no longer offers it

**Refresh never writes.** It only labels. Nothing reaches the config until you check boxes and press Save, which still goes through the backup / structural check / read-back-rollback path.

### Strongly recommended: declare a baseURL for every provider

```yaml
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        api: openai-completions
        baseURL: https://openrouter.ai/api/v1
```

Without a `baseURL`, the plugin must infer the endpoint by reading the installed pi-ai catalog out of `app.asar`. That path depends on the host environment and fails poorly when it does — as an unwritten response the client can only report as `HTTP 400 (empty body)`. Declaring `baseURL` goes straight to the network and never touches that code.

Verified endpoints:

| Provider | baseURL |
|---|---|
| openrouter | `https://openrouter.ai/api/v1` |
| opencode | `https://opencode.ai/zen/v1` |
| nvidia | `https://integrate.api.nvidia.com/v1` |

A `baseURL` change needs a DSH restart.

## Safety

Editing a config file is risky — a corrupted `cordis.patch.yml` can stop DSH from starting — so writes are guarded four ways:

| Guard | What it does |
|---|---|
| Surgical replace | Only the target provider's `models:` line block is rewritten; other providers and sections are untouched |
| Backup first | Every write emits `cordis.patch.yml.bak-lineup-<timestamp>` beforehand |
| Structural check | In-memory validation (no duplicate providers, legal model ids) before anything is written; rejects on failure |
| Read-back verify | Re-reads from disk and compares; restores the backup on mismatch |

Also: unknown providers are refused with 409; duplicate or whitespace-containing ids are rejected; request bodies are capped at 256 KB.

Backups accumulate. Clean up `cordis.patch.yml.bak-lineup-*` once you are happy with the config.

## How refresh works (and the traps)

### It must bypass pi-ai's built-in catalog

`discoverModels` returns the *installed* catalog — frozen at your DSH version — the moment it receives a `provider` argument. That is silent staleness: the feature looks like it works while showing months-old data. Refresh therefore sends `baseURL` and **never** `provider`. Guarded by `test-refresh.mjs` (R2).

### Namespace

`dsh-llm-pi-ai` registers model discovery under **its own** loader entry id — `llm-pi-ai` as declared in the profile. This plugin runs under a different entry, so deriving the namespace from `ctx.fiber.entry.options.id` yields `dsh-lineup-manager` and the kernel answers `NO_DISCOVERY`. The namespace is a constant. Guarded by `test-refresh.mjs` (R9).

### asar reads

The catalog lives inside `app.asar` (~174 MB). Reading it whole costs ~125 ms and hundreds of MB of RSS, multiplied across a refresh-all. The reader seeks: header plus the one entry's byte range. Measured 4 concurrent resolutions drop from ~905 MB to ~69 MB. Guarded by `test-asar.mjs`.

### Keys that expired

A platform answering `401 api_key_expired` makes that provider show a failure badge. Other providers are unaffected and your config is untouched — refresh reporting this is the point, not a bug.

## Layout

```
src/                  runtime sources
  index.js            host half: HTTP API over cordis.patch.yml
  client.js           browser half: the Settings panel
  cordis.patch.yml    bundle patch
scripts/build.mjs     emits dist/, verifies the copy
tests/                plain-Node test suites
dist/                 build output (not tracked)
```

## Development

```sh
pnpm build        # emit + verify dist/
pnpm test         # 66 checks across four suites
pnpm test:live    # hits real provider endpoints; needs real credentials
```

| Suite | Covers |
|---|---|
| `test-server.mjs` | config read/write, the four write guards (17) |
| `test-accept.mjs` | install integrity + end-to-end (22) |
| `test-refresh.mjs` | refresh diffing, catalog bypass, namespace, read-only (21) |
| `test-asar.mjs` | asar reader memory behavior (6) |

The four suites run entirely in temporary directories and never touch a real profile. `test-live.mjs` does hit the network and reads your real credentials; it also asserts the config is unchanged afterwards.

## License

[MIT](LICENSE)
