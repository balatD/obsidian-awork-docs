# awork Docs Sync

Two-way sync between [awork](https://www.awork.com) Docs and an Obsidian vault.

awork's API serves and accepts document content as **Markdown natively**
(`GET /documents/{id}/content?format=markdown`, `PUT` with
`contentFormat=markdown`), so notes cross the wire as-is — no HTML conversion
layer, no lossy round-trip through a rich-text model on this side.

> **This plugin sends your notes to a third-party service.** See
> [What leaves your vault](#what-leaves-your-vault) before installing.

## Installing

You need **Obsidian 1.5.7 or newer** on desktop, and an awork account. There is
nothing to register or configure first — the plugin sets up its own API access
when you connect.

Not in Obsidian's community plugin browser (yet), so pick one of these.

### With BRAT (recommended)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins straight
from GitHub and keeps them updated afterwards.

1. Install **BRAT** from Obsidian's community plugins browser and enable it.
2. Run the command **BRAT: Add a beta plugin for testing**.
3. Enter `balatD/obsidian-awork-docs` and confirm.
4. Settings → Community plugins → enable **awork Docs Sync**.

### By hand

1. Download `main.js` and `manifest.json` from the
   [latest release](https://github.com/balatD/obsidian-awork-docs/releases/latest).
2. Put both in `<your vault>/.obsidian/plugins/awork-docs/`, creating the folder
   if it does not exist.
3. Restart Obsidian, or Settings → Community plugins → **Reload plugins**.
4. Enable **awork Docs Sync**.

Updating means repeating this with the newer files, which is the main reason to
prefer BRAT.

### From source

```sh
git clone https://github.com/balatD/obsidian-awork-docs
cd obsidian-awork-docs
npm install && npm run build
mkdir -p "<your vault>/.obsidian/plugins/awork-docs"
cp main.js manifest.json "<your vault>/.obsidian/plugins/awork-docs/"
```

See [Development](#development) for the watch-mode loop.

### First run

1. Settings → **awork Docs Sync** → **Connect to awork**. Your browser opens
   awork's login and hands control back to Obsidian. If several vaults are open,
   close the others first so the callback reaches the right window.
2. Choose what to sync: your private docs, docs shared with you, and any
   document spaces. **Nothing syncs until at least one is selected.**
3. Press the sync icon in the left ribbon, or run **awork Docs Sync: Sync now**.

Your documents appear under `awork/` and the status bar shows when the last sync
finished. It then polls every 5 minutes by default, since awork has no webhooks
for documents.

Try it on a scratch vault first if you would rather watch it work before
pointing it at your real notes — it creates, moves and trashes files.

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

## Tables and images

**Tables.** awork writes most tables as Markdown pipe tables, but falls back to
raw `<table>` HTML whenever its editor holds something Markdown cannot express —
usually just a resized column. Obsidian renders that HTML but you cannot edit it
as a table, so tables whose only reason for being HTML was presentational are
converted back to pipe tables. Anything with a **merged cell, block content in a
cell, or markup the converter does not understand is left as HTML**, because a
lossy conversion would silently drop data. Converted tables push back cleanly —
awork parses pipe tables into real tables again, losing only the column width.

Markdown has no headerless table, so a table that never marked a header row can
only be converted by promoting its first row. That is a real change to the
document if the note is later pushed, so it is opt-in: Settings → *Tables* →
*Also promote the first row of headerless tables*.

**Images.** awork embeds images as workspace-relative URLs behind its API:

```
![](</api/v1/files/82e99766-…/download?crop=false&width=1024&…>)
```

Obsidian can render neither half of that — the path is relative to the API host,
and the host requires a bearer token an `<img>` tag cannot send. So images are
downloaded into `awork/_attachments` (configurable, empty disables it) and the
embeds rewritten to `![[82e99766-screenshot.jpg]]`, resolved by name so moving
the note or the folder cannot break them.

The original reference is kept in the sync state and **restored verbatim on
push**, so awork keeps its own file record and editing a note's text never
disturbs its images. A file that fails to download keeps its awork link rather
than becoming a broken local one, and the next sync retries.

Images you add in Obsidian go the other way: on push they are uploaded as
attachments on that awork document and the embed is replaced with awork's own
file reference, so they render there too. Only images are uploaded — a `![[…]]`
embed pointing at a PDF is left alone rather than becoming a broken picture.

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

## What leaves your vault

The plugin talks to **`api.awork.com`** and to nothing else. Over that connection
it sends and receives:

- **the full text and title of every synced document**, in both directions
- the names of your document spaces, and your own name and email (once, to show
  which account is connected)
- **images**: awork's are downloaded into the vault; images you embed in a synced
  note are uploaded to awork as attachments on that document

Three side effects worth knowing about before you install:

- **It registers an OAuth client on awork's servers.** On first connect the
  plugin creates its own API client via awork's public registration endpoint.
  That record lives in your awork workspace and is visible under
  Settings → Integrations.
- **Tokens are stored in plain text.** Obsidian gives plugins no secure storage,
  so the access and refresh tokens sit in
  `.obsidian/plugins/awork-docs/data.json` inside the vault. Exclude that file if
  you sync or commit the vault elsewhere. The token carries awork's `full_access`
  scope — the only meaningful one awork offers — so it can reach more than
  documents.
- **It creates, moves and trashes notes**, and can move awork documents to the
  workspace trash if you switch the deletion policy to mirroring. Nothing is
  deleted outright: notes go to Obsidian's trash and awork documents to awork's.

No telemetry, no analytics, no other hosts.

## Connecting

The plugin registers **its own OAuth client** with awork on first connect (RFC
7591 dynamic client registration, which awork exposes unauthenticated) and then
runs authorization-code + PKCE with an `obsidian://awork-docs-callback` redirect.
You do not need to be a workspace admin and there is nothing to paste.

Tokens are stored in `data.json` inside the vault, **in plain text** — Obsidian
gives plugins no secure storage. If the vault is synced or committed elsewhere,
exclude `.obsidian/plugins/awork-docs/data.json`.

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
echo "/path/to/TestVault/.obsidian/plugins/awork-docs" > .vault-path
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

## Not affiliated with awork

This is an independent, unofficial plugin. It is not built, endorsed or
supported by awork GmbH, and "awork" is their trademark, used here only to say
what the plugin talks to.

## Known limitations

- **No document webhooks in awork**, so changes are polled (default: every 5
  minutes, plus a manual command and ribbon icon).
- **Obsidian-specific syntax** — `[[wikilinks]]`, `![[embeds]]`, callouts,
  Dataview queries — is pushed as literal text and will not render in awork.
- **Mobile is untested.** Nothing in the source needs Node, so it may well work,
  but `isDesktopOnly` stays `true` until the `obsidian://` callback is actually
  verified on a phone.
- **The `full_access` scope is the only meaningful one awork offers**, so the
  token can reach more than documents.
- Rate limits (50/s, 1000/min) are **workspace-wide and shared with every other
  awork integration**; the client throttles to 4 concurrent requests and backs
  off on 429.
