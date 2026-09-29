---
name: godot
description: Drive an open Godot 4 editor. Use when the project has project.godot, a .tscn scene, GDScript, or the user asks to run, inspect, or fix a Godot game.
---

# Godot editor bridge

The bridge sees the editor that is already open. It does not attach to an exported game.

## Edit files yourself

Change these on disk:

- `.gd` scripts
- textual edits in `.tscn` and `.tres`
- `project.godot` for the input map, autoloads, and display size

Use `res://` paths with forward slashes. Never write a Windows path into a scene or script. Do not invent `uid://` values or `.uid` files; leave them out and Godot adds them.

## Call a tool when the editor knows more than the file

1. `godot_status` first. It lists open scenes and says whether a game is running. A `warning` field means the addon in the project is outdated; run the command it gives.
2. Read the script or scene file that matters.
3. Change the file, or set one live property with `godot_set_property`.
4. After writing files, call `godot_refresh`. Pass `scene` to open that scene, or to reload it if it is already open.
5. `godot_screenshot` before and after UI or layout changes, `view` `2d` or `3d`.
6. `godot_play`, then `godot_log` with `errors_only: true` when behavior matters. `play` runs the open scene, `main` the main scene, `stop` ends play.

`godot_scene_tree` lists the open scene without expanding instanced scenes. A node with a `children` count was cut by `depth`; ask for that node instead of a deeper tree.

`godot_node` returns only properties that differ from their defaults. A property missing from the answer has its default value. Pass `properties` to read exact names.

`godot_set_property` goes through editor undo and marks the scene unsaved. Vectors are `{x, y}` or `{x, y, z}`. Colors are `{r, g, b, a}` or a string such as `#ff8800`. `script` takes a `res://` `.gd` path. It cannot call methods, connect signals, or add nodes; edit the scene file for those.

## Do not lose changes

Reloading a scene with `godot_refresh` drops unsaved editor changes to that scene. If you set properties live and then want to edit the same `.tscn` on disk, pass `save: true` on the last `godot_set_property` first. If the user may have unsaved work in that scene, ask them to save before you touch the file.

## When the bridge is missing

`godot_status` returns the exact install command with absolute paths. Run it, then ask the user to restart the Godot editor. The installer copies `addons/claude_godot`, enables it in `project.godot`, and gitignores `.claude-godot/`.

If the game lives in a subfolder and several projects are found, the user can set `GODOT_PROJECT` to the folder that contains `project.godot`.

A screenshot fails when the editor window is minimized or runs headless. The log is empty until the game has been played once with file logging on.
