# NoteSmith Notes for VS Code

Link a [NoteSmith](https://notesmith.io) folder — or a local-only encrypted **vault** — to a project, then browse, create and edit its notes as Markdown without leaving VS Code.

- A **NoteSmith** view in the Explorer lists the linked folder (with subfolders) and/or the linked vault.
- Click a note to open it as Markdown. **Ctrl+S saves it back** to NoteSmith (or into the vault on disk).
- **New Note** from the view title or any folder's inline button.
- **Open in NoteSmith** (right-click) jumps to the note in the browser.

## Setup

1. Install the `.vsix` from the [latest release](https://github.com/VAROIndustries/VSCodeNoteSmithPlugin/releases/latest): *Extensions → … → Install from VSIX…*
2. In NoteSmith, create an API key (Settings → API keys). In VS Code run **NoteSmith: Set API Key**. The key goes into VS Code's secret storage, never into settings.
3. Open your project folder and run **NoteSmith: Link NoteSmith Folder to Project**. Pick a workspace and folder. The link is saved in the project's `.vscode/settings.json` (`notesmith.workspaceId`, `notesmith.folderId`), so it travels with the repo if you commit it.

## Vaults (local-only folders)

A NoteSmith vault never touches the server — its notes live encrypted in a folder on your disk. VS Code reads and writes that folder directly, using the same format as the web app (PBKDF2-SHA256 → AES-256-GCM, `vault.json` + `index.enc` + one `.enc` per note).

1. Run **NoteSmith: Link Local Vault to Project** and choose the folder you picked as the vault in NoteSmith.
2. Enter your daily passphrase (or backup code). Pick which vault folder to link.
3. Each VS Code window asks for the passphrase again (**NoteSmith: Unlock Vault**). The key is held in memory only; **Lock Vault** drops it.

The vault's disk path is stored per machine (not in `settings.json`); only the vault folder id is shared. A vault only works on a machine that has the vault directory — there's no server copy to fall back to.

## Claude Code can read and write the unlocked vault

When a vault is linked, the extension runs a small MCP server on `127.0.0.1:47210` (`notesmith.mcpPort`, `0` turns it off). Its tools are `list_notes`, `read_note` and `write_note`, and they work only on the linked vault folder, only while it's unlocked in this window.

1. Run **NoteSmith: Connect Claude Code to Vault**. A `claude mcp add --scope user …` command goes to your clipboard.
2. Paste it into a terminal once, then restart Claude Code (or `/mcp` → reconnect).

While the vault is locked, the tools reply "vault is locked" and Claude asks you to unlock it. Notes that open read-only in the editor are read-only for Claude too. If one of Claude's writes changes a note you have open, the tab reloads.

- **Trade-off:** the bearer token is stored in plain text in `~/.claude.json`. While the vault is unlocked, anything on this machine that can read that file can read the vault. Lock it when you're done.
- The port can only be used once per machine. Only the first VS Code window with a linked vault serves it. Other windows show a warning.

## What opens read-only, and why

Notes are edited as Markdown and converted back on save. Content Markdown can't carry would be lost, so those notes open **read-only** with a message saying why — edit them in NoteSmith instead:

- task lists, callouts, images/attachments, audio, mentions, highlight/underline/colour marks (vault notes: exact type check)
- images and task lists (server notes: syntax check)
- anything whose Markdown wouldn't come back identical after a save

Saving a note you didn't change does nothing.

## Caveats

- **Last writer wins.** Saving replaces the note's content. If the same note is open in the NoteSmith web editor at the same time, whichever saves last wins. For vaults, VS Code re-reads the index before every write, but the web app doesn't — don't edit the same vault in both at once.
- Titles, deletes and moves are done in NoteSmith (the view refreshes with the ↻ button).
- Self-hosted NoteSmith: set `notesmith.apiBase`.

## Development

Plain JavaScript, no build step. `npm install`, then `node test.js` (builds a vault the way the web app does and round-trips it). Package with `npx @vscode/vsce package`.

The Markdown converters in `markdown.js` are vendored from NoteSmith so vault notes convert exactly like API notes. Keep them in sync when the server's change.

MIT licensed.
