# awork Sync for Obsidian

Two-way sync between [awork](https://www.awork.com) Docs and an Obsidian vault.

awork's API serves and accepts document content as **Markdown natively**
(`GET /documents/{id}/content?format=markdown`, `PUT` with
`contentFormat=markdown`), so notes cross the wire as-is — no HTML conversion
layer, no lossy round-trip through a rich-text model on this side.

## What it syncs

| Scope | Vault folder | Direction |
| --- | --- | --- |
| Selected document spaces | `awork/<Space>/…` | both ways |
| Your private docs | `awork/Private/…` | both ways |
| Docs shared with you | `awork/Shared with me/…` | both ways, but new notes here are ignored |

Project docs are deliberately out of scope.

### Documents inside documents

awork lets a document hold child documents; Obsidian has only folders. Since
Obsidian sorts every folder above every file, a parent placed *beside* its
folder ends up separated from its own children — so by default the parent goes
**inside** the folder it owns:

```
awork/Private/Kunden/
    Kunden.md        ← the parent document itself
    BEAS.md          ← its children
    Holzland - Formulare.md
```

This is the convention the [Folder Notes](https://github.com/LostPaul/obsidian-folder-notes)
plugin recognises, so clicking the folder opens the parent. Settings →
*Documents that contain other documents* switches to `Kunden.md` beside
`Kunden/` if you prefer.

Either way, **dropping a note into a folder makes it a child of that folder's
document** — both conventions are recognised on the way in, whichever is
configured, because a document with no children yet has no folder to sit in. A
document that gains its first child moves into its folder on the next sync; one
that loses its last child moves back out.

## Properties in your notes

**Nothing in a note's frontmatter is ever sent to awork.** It is stripped before
every push and re-added after every pull, so awork documents stay clean no
matter which style you pick below.

Settings → *awork properties in notes*:

| Style | Written into each note | Trade-off |
| --- | --- | --- |
| **Just the id** (default) | `awork-id` | one line; survives moving notes around |
| Id, last change and link | `awork-id`, `awork-updated`, `awork-url` | handy `awork-url` to jump to the document |
| **None** | nothing | pristine notes; documents are matched by their recorded path, so moving a note while the plugin is off can orphan it |

awork itself prepends a `---\nname: <title>\n---` block to every markdown
export. It is decoration, not content — awork regenerates it on export and
ignores it on import (writing content with a different `name:` does not rename
the document), so the plugin strips it and your notes never show it.

Switching styles rewrites existing notes immediately and prunes the keys the new
style does not want. Your own properties (`tags`, `aliases`, anything another
plugin owns) are never touched. There is also a command, **awork Sync: Clean up
awork properties in synced notes**, which re-applies the current style and
removes any leftover export header from notes synced by an older version.

To hide properties without changing what is stored, use Obsidian's own
Settings → Editor → **Properties in document** → *Hidden*.

## How it decides what changed

- **Identity is the id, never the path.** Renaming or moving on either side is a
  move, not a delete plus a create. With the *None* property style there is no id
  in the file, so the path recorded by the last sync is used instead.
- **Local changes are detected by hashing the body with frontmatter stripped.**
  That is what keeps the plugin's own `awork-updated` write-back from looking
  like a user edit — no feedback loop, and no dependence on mtime, which
  Obsidian Sync and git both rewrite.
- **Remote changes are detected via `updatedOn`.**

### Conflicts

When both sides changed since the last sync, **the newer side wins** (awork's
`updatedOn` versus the note's mtime; ties go to awork). The losing version is
never discarded — it is written to `awork/_conflicts/` with a banner naming the
document and the timestamp, so you can merge by hand.

### Deletions

- Gone from awork → the note moves to the Obsidian trash.
- Deleted in the vault → by default it is downloaded again. Switch
  *"When a synced note is deleted here"* to mirroring if you want the awork
  document moved to the workspace trash instead.

## Connecting

The plugin registers **its own OAuth client** with awork on first connect (RFC
7591 dynamic client registration, which awork exposes unauthenticated) and then
runs authorization-code + PKCE with an `obsidian://awork-sync-callback` redirect.
You do not need to be a workspace admin and there is nothing to paste.

Tokens are stored in `data.json` inside the vault, **in plain text** — Obsidian
gives plugins no secure storage. If the vault is synced or committed elsewhere,
exclude `.obsidian/plugins/awork-sync/data.json`.

Refresh tokens are valid 30 days and rotate on use, so leaving Obsidian closed
for longer than that means reconnecting.

## Development

```sh
npm install
npm run dev        # watch build; see .vault-path below
npm run build      # typecheck + production bundle
npm test           # vitest, no Obsidian required
```

For a live-reload loop, write the absolute path of a test vault's plugin folder
into `.vault-path`:

```sh
echo "/path/to/TestVault/.obsidian/plugins/awork-sync" > .vault-path
npm run dev
```

Each rebuild copies `main.js` and `manifest.json` there; reload Obsidian with
*Reload app without saving*.

### Checking markdown fidelity without a vault

awork converts between its editor model and markdown on every read and write.
To see exactly what that costs on real documents:

```sh
npm run -s connect              # PKCE login via a loopback redirect
npm run -s roundtrip -- --list  # list documents in scope
npm run -s roundtrip -- <id>            # print the markdown awork returns
npm run -s roundtrip -- <id> --write    # write it back and diff the result
```

To run a whole sync pass outside Obsidian — useful for telling an engine problem
apart from an Obsidian one — use `npm run -s dry-run`. It plans and pulls against
the live workspace into an in-memory vault, writing nothing to disk or to awork.

Use a throwaway document space for `--write`. `AWORK_TOKEN=<api key>` works
instead of `connect` if you have a workspace API key.

### Releasing

Obsidian installs plugins from GitHub *release assets*, and the community index
matches the release tag against `manifest.json` exactly — no `v` prefix.

```sh
npm version patch          # bumps package.json, manifest.json and versions.json
git push && git push --tags
```

The tag push triggers `.github/workflows/release.yml`, which refuses to publish
if the tag and manifest disagree or `versions.json` is missing the entry, then
runs the checks and attaches `main.js`, `manifest.json` (and `styles.css` when
one exists) to the release.

Until this is in the community directory, install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat): *Add beta plugin* →
`balatD/obsidian-awork-docs`.

### Layout

```
src/core/      framework-free: ports, mapping, markdown, plan, sync engine, state
src/api/       awork HTTP client, multipart builder, throttling + 429 backoff
src/auth/      dynamic client registration, PKCE, token store
src/obsidian/  vault adapter, requestUrl transport
src/           main.ts (plugin), settings.ts, sync-service.ts
tests/         vitest against in-memory fakes of both ports
```

`src/core` imports nothing from Obsidian, which is why the whole sync algorithm
is testable in plain Node.

## Performance

A sync pass costs one round trip per document whose content actually moved, plus
three listing requests. Two things keep that cheap:

**Documents are synced in parallel.** Actions touching the same document stay in
order; different documents run concurrently. Measured against a real workspace of
64 documents, cold:

| Documents at once | Cold sync | Notes |
| --- | --- | --- |
| 1 | ~7.7s | |
| 2 | ~4.6s | |
| **4 (default)** | **~3.1s** | all 67 requests answered 200 |
| 8 | ~3.9s | *slower*; no throttling, so this is server-side latency |
| 16 | — | 14 requests answered 429 and had to back off |

Raising it past 4 does not help. awork's limit is 50 requests/second and
1000/minute per workspace, shared with every other integration on it.

**Unchanged notes are never re-read.** The scan remembers each note's mtime and
body hash, so a steady-state pass only reads the files that actually moved and
transfers only the documents whose `updatedOn` advanced. On a settled vault a
pass is three requests and no file reads at all.

If a sync feels slow, `npm run -s dry-run` prints the response-status histogram
alongside the plan, which distinguishes rate limiting from plain latency.

## Known limitations

- **No document webhooks in awork**, so changes are polled (default: every 5
  minutes, plus a manual command and ribbon icon).
- **Obsidian-specific syntax** — `[[wikilinks]]`, `![[embeds]]`, callouts,
  Dataview queries — is pushed as literal text and will not render in awork.
- **Attachments are not synced yet.** Images in awork documents stay as
  authenticated awork URLs and will not render in Obsidian.
- **The `full_access` scope is the only meaningful one awork offers**, so the
  token can reach more than documents.
- Rate limits (50/s, 1000/min) are **workspace-wide and shared with every other
  awork integration**; the client throttles to 4 concurrent requests and backs
  off on 429.
