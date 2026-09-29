import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { installerPath, run, startServer, tempProject, toolJson } from "./helpers.mjs";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const TOKEN = "ab".repeat(16);
const TOOL_NAMES = [
  "godot_status",
  "godot_scene_tree",
  "godot_node",
  "godot_set_property",
  "godot_screenshot",
  "godot_log",
  "godot_play",
  "godot_refresh",
];

function fakeEditor(handler) {
  const requests = [];
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const request = JSON.parse(buffer.slice(0, newline));
        requests.push(request);
        const reply = request.token === TOKEN ? handler(request) : { error: "bad token" };
        socket.end(`${JSON.stringify({ id: request.id, ...reply })}\n`);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });
}

function writeSession(project, session) {
  fs.mkdirSync(path.join(project, ".claude-godot"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude-godot", "session.json"), JSON.stringify(session));
}

test("lists the eight tools and validates arguments before connecting", async () => {
  const project = tempProject();
  const client = startServer({ CLAUDE_PROJECT_DIR: project, GODOT_PROJECT: "" });
  try {
    const init = await client.request("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.result.serverInfo.name, "claude-godot");
    assert.equal(init.result.protocolVersion, "2025-06-18");
    const listed = await client.request("tools/list", {});
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), TOOL_NAMES);

    const cases = [
      ["godot_set_property", { property: "script()", value: "res://a.gd" }, /property has an invalid format/],
      ["godot_set_property", { path: "../Other", property: "visible", value: true }, /path has an invalid format/],
      ["godot_set_property", { property: "position", value: { x: 1, w: 2 } }, /x, y, z/],
      ["godot_scene_tree", { depth: 99 }, /depth must be an integer/],
      ["godot_node", { properties: [] }, /list of 1 to 20/],
      ["godot_refresh", { scene: "res://../x.tscn" }, /scene has an invalid format/],
      ["godot_play", { action: "pause" }, /action must be one of/],
      ["godot_log", { errors_only: "yes" }, /true or false/],
    ];
    for (const [name, args, pattern] of cases) {
      const result = await client.tool(name, args);
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, pattern);
    }

    const missing = await client.tool("godot_status");
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /install-addon\.mjs/);
  } finally {
    client.stop();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("talks to the editor on localhost with the session token", async () => {
  const project = tempProject();
  const editor = await fakeEditor((request) => {
    if (request.method === "status") return { result: { addon: "0.2.0", project_name: "Demo", playing: false } };
    if (request.method === "screenshot") {
      return { result: { view: "2d", width: 1, height: 1, file: path.join(project, ".claude-godot", "viewport.png") } };
    }
    if (request.method === "log") return { result: { lines: request.params.errors_only ? ["ERROR: boom"] : [] } };
    return { error: "unexpected" };
  });
  writeSession(project, { port: editor.port, token: TOKEN, project, host: "203.0.113.5" });
  fs.writeFileSync(path.join(project, ".claude-godot", "viewport.png"), TINY_PNG);
  const client = startServer({ CLAUDE_PROJECT_DIR: project, GODOT_PROJECT: "" });
  try {
    const status = toolJson(await client.tool("godot_status"));
    assert.equal(status.project_name, "Demo");
    assert.equal(status.warning, undefined);

    const log = toolJson(await client.tool("godot_log", { errors_only: true }));
    assert.deepEqual(log.lines, ["ERROR: boom"]);
    assert.deepEqual(editor.requests.at(-1).params, { lines: 40, errors_only: true });

    const shot = await client.tool("godot_screenshot", { view: "2d" });
    assert.equal(shot.content[1].mimeType, "image/png");
    assert.equal(shot.content[1].data, TINY_PNG.toString("base64"));

    writeSession(project, { port: editor.port, token: "ff".repeat(16), project });
    const denied = await client.tool("godot_status");
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /bad token/);
  } finally {
    client.stop();
    await new Promise((resolve) => editor.server.close(resolve));
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("warns when the addon in the project is older than the plugin", async () => {
  const project = tempProject();
  const editor = await fakeEditor(() => ({ result: { project_name: "Old" } }));
  writeSession(project, { port: editor.port, token: TOKEN, project });
  const client = startServer({ CLAUDE_PROJECT_DIR: project, GODOT_PROJECT: "" });
  try {
    const status = toolJson(await client.tool("godot_status"));
    assert.match(status.warning, /does not match plugin 0\.2\.0/);
  } finally {
    client.stop();
    await new Promise((resolve) => editor.server.close(resolve));
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("refuses a screenshot path outside the project", async () => {
  const project = tempProject();
  const outside = tempProject();
  fs.writeFileSync(path.join(outside, "leak.png"), TINY_PNG);
  const editor = await fakeEditor(() => ({ result: { view: "2d", width: 1, height: 1, file: path.join(outside, "leak.png") } }));
  writeSession(project, { port: editor.port, token: TOKEN, project });
  const client = startServer({ CLAUDE_PROJECT_DIR: project, GODOT_PROJECT: "" });
  try {
    const shot = await client.tool("godot_screenshot");
    assert.equal(shot.isError, true);
    assert.match(shot.content[0].text, /outside the project/);
  } finally {
    client.stop();
    await new Promise((resolve) => editor.server.close(resolve));
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("finds a Godot project in a subfolder of the working directory", async () => {
  const repo = tempProject("");
  fs.rmSync(path.join(repo, "project.godot"));
  const game = path.join(repo, "game");
  fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "project.godot"), "config_version=5\n");
  const client = startServer({ CLAUDE_PROJECT_DIR: repo, GODOT_PROJECT: "" });
  try {
    const result = await client.tool("godot_status");
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes(`not running for ${game}`), result.content[0].text);
  } finally {
    client.stop();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("installer replaces the addon, enables it, and gitignores the session", async () => {
  const project = tempProject(
    '; Engine configuration file.\r\nconfig_version=5\r\n\r\n[editor_plugins]\r\n\r\nenabled=PackedStringArray("res://addons/other/plugin.cfg")\r\n',
  );
  const stale = path.join(project, "addons", "claude_godot", "output_capture.gd");
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, "stale");
  try {
    const first = await run(process.execPath, [installerPath, project]);
    assert.equal(first.code, 0, first.stderr);
    const second = await run(process.execPath, [installerPath, project]);
    assert.equal(second.code, 0, second.stderr);

    assert.equal(fs.existsSync(path.join(project, "addons", "claude_godot", "plugin.gd")), true);
    assert.equal(fs.existsSync(stale), false);
    const config = fs.readFileSync(path.join(project, "project.godot"), "utf8");
    assert.match(config, /enabled=PackedStringArray\("res:\/\/addons\/other\/plugin\.cfg", "res:\/\/addons\/claude_godot\/plugin\.cfg"\)\r\n/);
    assert.equal(config.split("claude_godot/plugin.cfg").length, 2);
    const ignore = fs.readFileSync(path.join(project, ".gitignore"), "utf8");
    assert.equal(ignore, ".claude-godot/\n");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("installer adds an editor_plugins section when there is none", async () => {
  const project = tempProject('config_version=5\n\n[application]\n\nconfig/name="Demo"\n');
  try {
    const result = await run(process.execPath, [installerPath, project]);
    assert.equal(result.code, 0, result.stderr);
    const config = fs.readFileSync(path.join(project, "project.godot"), "utf8");
    assert.ok(config.endsWith('\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/claude_godot/plugin.cfg")\n'), config);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
