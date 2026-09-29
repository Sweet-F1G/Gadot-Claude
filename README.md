# claude-godot

A Claude Code plugin for the open Godot 4 editor. Eight tools: status, scene tree, one node, one property, a viewport screenshot, play, the game log, and a file rescan. It does not load hundreds of tools into context, and it answers in compact JSON.

The bridge only talks to the editor on this machine. It does not attach to an exported game.

## Requirements

- Godot 4.2 or newer (tested on 4.2.2 and 4.7.2)
- Node.js 18 or newer (`node` on `PATH`)
- Claude Code

## Install the plugin

In Claude Code, from any folder:

```text
/plugin marketplace add Sweet-F1G/Gadot-Claude
/plugin install claude-godot@claude-godot
```

Without an SSH key for GitHub, add the marketplace over HTTPS: `/plugin marketplace add https://github.com/Sweet-F1G/Gadot-Claude.git`.

To try it from a clone without a marketplace:

```text
claude --plugin-dir ./plugins/claude-godot
```

## Connect a project

Open Claude in the game folder, or in a repository where the game sits one or two levels down. The server looks for `project.godot` in parent folders and two levels below. If it finds several projects, set `GODOT_PROJECT` to the one you want.

The easiest start is to ask Claude to check the Godot connection: `godot_status` returns the install command with full paths. To install by hand from a clone:

```text
node plugins/claude-godot/scripts/install-addon.mjs C:\path\to\your-game
```

The script replaces `addons/claude_godot` in the game, enables the addon in `project.godot`, and adds `.claude-godot/` to `.gitignore`. Pass `--no-enable` to enable it yourself. Run it with the editor closed: an open editor can overwrite `project.godot`.

Restart the editor. The Godot output shows `Claude Godot 0.2.0 listening on 127.0.0.1:8787`. If that port is taken, the addon tries the next ones up to 8796.

## Tools

| Tool | Purpose |
| --- | --- |
| `godot_status` | Versions, project, open scenes, whether a game is running |
| `godot_scene_tree` | Hierarchy of the open scene; instanced scenes stay collapsed |
| `godot_node` | Script, children, and properties that differ from their defaults |
| `godot_set_property` | One property through editor undo, optionally saving the scene |
| `godot_screenshot` | 2D or 3D viewport, up to 960 px wide; a heavy PNG falls back to JPEG |
| `godot_play` | `play`, `main`, or `stop` |
| `godot_log` | Tail of `user://logs/godot.log` from the last run, optionally errors only |
| `godot_refresh` | Rescan files, open a scene, or reload it from disk |

Claude edits scripts, scenes, and `project.godot` as files. The bridge covers what files cannot show: the live tree, the editor image, play, and the log.

`godot_refresh` on a scene that is already open reloads it from disk. Unsaved changes to that scene are lost.

If the plugin was updated but the addon in the game is older, `godot_status` returns a warning with the reinstall command.

## Tests

```text
node --test plugins/claude-godot/test/mcp.test.mjs plugins/claude-godot/test/godot.e2e.test.mjs
```

The real-editor test runs when `GODOT_BIN` points to a Godot 4 console executable. It starts a headless editor and checks every tool except the screenshot.

## Security

The addon listens on `127.0.0.1` only. Every connection is checked against the token in `.claude-godot/session.json`. The file is rewritten when the editor starts and deleted when it exits. The MCP server ignores any host in the session file and always connects to localhost. Screenshots are read only from inside the project folder. Object properties and method calls do not go through the bridge.

The token lives in the project folder. Do not commit it; the installer adds `.claude-godot/` to `.gitignore`.
