// Runs the addon inside a real headless Godot editor.
// Skipped unless GODOT_BIN points to a Godot 4 executable.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installerPath, run, startServer, toolJson } from "./helpers.mjs";

const GODOT = process.env.GODOT_BIN;
const SESSION_TIMEOUT_MS = 120000;

const MAIN_SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1"]

[node name="Main" type="Node2D"]
script = ExtResource("1")

[node name="Player" type="Sprite2D" parent="."]
position = Vector2(10, 20)

[node name="Label" type="Label" parent="."]
text = "hello"
`;

const MAIN_SCRIPT = `extends Node2D

@export var speed := 5


func _ready() -> void:
	print("e2e ready")
	push_error("e2e boom")
	get_tree().quit()
`;

function userDataDir(name) {
  const base = process.platform === "win32" ? process.env.APPDATA : path.join(os.homedir(), ".local", "share");
  return path.join(base, "Godot", "app_userdata", name);
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("addon answers every tool from a headless Godot editor", { skip: !GODOT, timeout: 240000 }, async () => {
  const name = `ClaudeGodotE2E${process.pid}${Date.now()}`;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "claude-godot-e2e-"));
  fs.writeFileSync(
    path.join(project, "project.godot"),
    `config_version=5\n\n[application]\n\nconfig/name="${name}"\nrun/main_scene="res://main.tscn"\n`,
  );
  fs.writeFileSync(path.join(project, "main.tscn"), MAIN_SCENE);
  fs.writeFileSync(path.join(project, "main.gd"), MAIN_SCRIPT);

  let editor;
  let editorOutput = "";
  const client = startServer({ CLAUDE_PROJECT_DIR: project, GODOT_PROJECT: "" });
  try {
    const install = await run(process.execPath, [installerPath, project]);
    assert.equal(install.code, 0, install.stderr);

    const game = await run(GODOT, ["--headless", "--path", project]);
    assert.match(game.stdout + game.stderr, /e2e ready/);

    editor = spawn(GODOT, ["--headless", "--editor", "--path", project], { stdio: ["ignore", "pipe", "pipe"] });
    editor.stdout.on("data", (chunk) => {
      editorOutput += chunk.toString("utf8");
    });
    editor.stderr.on("data", (chunk) => {
      editorOutput += chunk.toString("utf8");
    });
    const sessionFile = path.join(project, ".claude-godot", "session.json");
    await waitFor(() => fs.existsSync(sessionFile), SESSION_TIMEOUT_MS, `session file\n${editorOutput}`);

    const status = toolJson(await client.tool("godot_status"));
    assert.equal(status.addon, "0.2.0");
    assert.equal(status.project_name, name);
    assert.equal(status.warning, undefined);

    const opened = toolJson(await client.tool("godot_refresh", { scene: "res://main.tscn" }));
    assert.equal(opened.scene, "res://main.tscn");

    const tree = toolJson(await client.tool("godot_scene_tree"));
    assert.deepEqual(
      tree.nodes.map((node) => [node.path, node.type]),
      [
        [".", "Node2D"],
        ["Player", "Sprite2D"],
        ["Label", "Label"],
      ],
    );
    assert.equal(tree.nodes[0].script, "res://main.gd");

    const player = toolJson(await client.tool("godot_node", { path: "Player" }));
    assert.deepEqual(player.properties.position, { x: 10, y: 20 });
    assert.equal(Object.hasOwn(player.properties, "visible"), false);
    assert.equal(Object.keys(player.properties)[0], "position");

    const root = toolJson(await client.tool("godot_node", { path: ".", properties: ["speed", "nope"] }));
    assert.equal(root.properties.speed, 5);
    assert.deepEqual(root.missing, ["nope"]);
    assert.deepEqual(root.children, ["Player", "Label"]);

    const moved = toolJson(await client.tool("godot_set_property", { path: "Player", property: "position", value: { x: 3, y: 4 }, save: true }));
    assert.deepEqual(moved.value, { x: 3, y: 4 });
    assert.equal(moved.saved, true);
    assert.match(fs.readFileSync(path.join(project, "main.tscn"), "utf8"), /position = Vector2\(3, 4\)/);

    const tinted = toolJson(await client.tool("godot_set_property", { path: "Label", property: "modulate", value: "#ff0000" }));
    assert.deepEqual(tinted.value, { r: 1, g: 0, b: 0, a: 1 });

    const wrongType = await client.tool("godot_set_property", { path: "Player", property: "visible", value: "no" });
    assert.equal(wrongType.isError, true);
    assert.match(wrongType.content[0].text, /does not fit visible/);

    const shot = await client.tool("godot_screenshot");
    assert.equal(shot.isError, true);
    assert.match(shot.content[0].text, /headless/);

    const log = toolJson(await client.tool("godot_log", { errors_only: true }));
    assert.ok(log.lines.some((line) => line.includes("e2e boom")), JSON.stringify(log));
    assert.ok(log.lines.every((line) => !line.includes("e2e ready")), JSON.stringify(log));

    const stopped = toolJson(await client.tool("godot_play", { action: "stop" }));
    assert.equal(stopped.playing, false);

    fs.writeFileSync(path.join(project, "main.tscn"), MAIN_SCENE.replace('text = "hello"', 'text = "from disk"'));
    const reloaded = toolJson(await client.tool("godot_refresh", { scene: "res://main.tscn" }));
    assert.equal(reloaded.reloaded, "res://main.tscn");
    const label = toolJson(await client.tool("godot_node", { path: "Label", properties: ["text"] }));
    assert.equal(label.properties.text, "from disk");

    assert.doesNotMatch(editorOutput, /SCRIPT ERROR|Parse Error/, editorOutput);
  } finally {
    client.stop();
    if (editor) editor.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(userDataDir(name), { recursive: true, force: true });
  }
});
