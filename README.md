# pi-command-history

Folder-based persistent command history for [pi](https://github.com/badlogic/pi-mono). Recall previous commands with `ctrl+up`/`ctrl+down` across sessions, or open an fzf-like fuzzy picker with `ctrl+r`.

## Install

```bash
pi install /home/spike/hobby/pi-command-history
```

Or try without installing:

```bash
pi -e /home/spike/hobby/pi-command-history
```

## Usage

| Shortcut | Action |
|----------|--------|
| `ctrl+r` | Fuzzy search command history for the current folder |
| `ctrl+up` | Previous command (older) |
| `ctrl+down` | Next command (newer) |

When you enter a command in pi, it is saved to a per-folder history file. Next time you open pi in the same folder, press `ctrl+r` to filter previous commands and press Enter to place the selected command in the editor. Inside the picker, press `Tab` to toggle into a mode that searches only among the initial prompts of unique Pi sessions for the current folder.

### Fuzzy picker controls

| Key | Action |
|-----|--------|
| Text input | Filter commands |
| `up` / `down` | Move selection |
| `ctrl+p` / `ctrl+n` | Move selection |
| `left` / `right` | Scroll selected command horizontally by 10 columns |
| `enter` | Accept selected command |
| `escape` / `ctrl+c` | Cancel |
| `Tab` | Toggle between command history and session-start prompts |
| `backspace` | Remove last query character |

### What gets saved

- All user input is saved, including `/` slash commands.
- Multi-line commands are preserved in storage, but displayed as one line in the picker by replacing line breaks with spaces.
- History is deduplicated: repeated commands move to the most recent position.
- Up to 500 commands are stored per folder.

### How it works

- History files are stored in `~/.pi/folder-history/` as JSONL, keyed by the working directory.
- A status indicator in the footer shows the number of saved commands.
- `ctrl+r` uses a hidden Pi overlay to capture keys and draws a framed modal directly on the main terminal screen. This avoids the `pi-tui` overlay diff path that can scroll the chat while moving through rows.
- Compatible with other editor extensions because it does not replace the editor.

## Development

```bash
npm install
npm test
npm run typecheck
```

## Uninstall

```bash
pi remove /home/spike/hobby/pi-command-history
```

To also remove saved history:

```bash
rm -rf ~/.pi/folder-history/
```

## License

MIT
