# OpenLoops Hidden Files

An Obsidian plugin that reveals a **chosen list** of dot-folders (for example
`.claude`, `.github`) in the native file-explorer tree — folders Obsidian hides
by default.

Obsidian filters out any path starting with `.` *at the vault-adapter level*, so
dot-folders never become files/folders Obsidian can show, search, or graph. This
plugin injects the folders you explicitly whitelist into the live vault cache so
they appear in the normal file explorer (and search, graph, and metadata cache).
Injection is index-only — it never writes to disk.

## Why per-folder opt-in

Revealing everything is dangerous: pointing Obsidian at a large folder such as
`.git` makes it scan every object and can freeze the app. This plugin only ever
reveals folders you name, so heavy folders are never touched unless you ask.

## Usage

1. Enable the plugin (desktop only).
2. Open **Settings → OpenLoops Hidden Files**.
3. Add a folder — pick a detected root dot-folder from the dropdown, or type any
   vault-relative path — and click **Add**. It appears in the file explorer.
4. Remove it (or disable the plugin) to hide it again. Your files on disk are
   never modified.

The command **OpenLoops Hidden Files: Rescan hidden folders** re-applies your list,
useful after adding folders on disk.

## Limitations

- **Desktop only.** Mobile Obsidian does not expose the filesystem primitives the
  plugin relies on, so it cannot work there.
- **Relies on undocumented Obsidian internals.** The plugin wraps internal
  `FileSystemAdapter` methods. A future Obsidian release could change them; the
  plugin verifies the methods exist at load and stays inactive if they are gone,
  rather than breaking the app.

## Security notes

- **Revealing a folder exposes it to everything, not just your eyes.** Once a
  folder is whitelisted, its files become ordinary vault files: indexed by
  search and the graph, and readable by **every other installed plugin** through
  the standard vault API — including sync plugins that upload your vault. Do not
  reveal folders that contain secrets (for example `.env`, `.git`, API keys, or
  tokens), especially on a managed/work machine.
- **The plugin never writes to disk.** It only reads directory listings and
  injects entries into Obsidian's in-memory cache. Removing a folder or disabling
  the plugin leaves your files untouched.
- **Path validation.** Only relative in-vault paths are accepted; entries with
  `..` segments or absolute paths are rejected so a revealed folder cannot escape
  the vault.

## Credits

Technique derived from the MIT-licensed
[`dsebastien/obsidian-hidden-folders-access`](https://github.com/dsebastien/obsidian-hidden-folders-access).

## License

[MIT](LICENSE)
