#!/usr/bin/env node
// Local MCP server. Talks to the Godot addon over 127.0.0.1 only.
// Requires Node 18+.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "0.2.0";
const SERVER_INFO = { name: "claude-godot", version: VERSION };
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(PLUGIN_ROOT, "scripts", "install-addon.mjs");
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const BRIDGE_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_IMAGE_BYTES = 1_500_000;
const SEARCH_DEPTH = 2;
const SEARCH_DIR_LIMIT = 200;
const SKIP_DIRS = new Set(["node_modules", "addons", "build", "builds", "export", "exports", "dist"]);

const NODE_PATH = { type: "string", maxLength: 512, pattern: "^(\\.|[^./\\\\][^.\\\\:]*)$" };
const PROPERTY = { type: "string", maxLength: 80, pattern: "^[A-Za-z_][A-Za-z0-9_/]*$" };
const RES_PATH = { type: "string", maxLength: 512, pattern: "^res://(?!.*\\.\\.)[^\\\\]+$" };
const VALUE_KEYS = new Set(["x", "y", "z", "r", "g", "b", "a"]);

const TOOLS = [
  {
    name: "godot_status",
    description: "Check the open Godot editor: versions, project, open scenes, whether a scene is playing. Call first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "godot_scene_tree",
    description:
      "Nodes of the scene open in the editor. Paths are relative to the scene root. Instanced scenes are not expanded. Nodes cut by depth report a children count.",
    inputSchema: {
      type: "object",
      properties: {
        depth: { type: "integer", minimum: 1, maximum: 8, description: "Levels under the root. Default 4." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum nodes. Default 80." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "godot_node",
    description:
      "One node of the edited scene: type, script, child names, and properties that differ from their defaults. Pass properties to read exact names instead.",
    inputSchema: {
      type: "object",
      properties: {
        path: { ...NODE_PATH, description: "Path from the scene root, or '.' for the root. Example: Player/Sprite2D" },
        properties: { type: "array", items: PROPERTY, minItems: 1, maxItems: 20, description: "Exact property names to read." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "godot_set_property",
    description:
      "Set one property on a node in the edited scene, with editor undo. Vectors {x,y} or {x,y,z}; colors {r,g,b,a} or '#rrggbb'; script takes a res:// .gd path. Cannot call methods or add nodes.",
    inputSchema: {
      type: "object",
      required: ["property", "value"],
      properties: {
        path: { ...NODE_PATH, description: "Path from the scene root, or '.' for the root." },
        property: { ...PROPERTY, description: "Property name, such as position, visible, text, or modulate." },
        value: { description: "New value: string, number, boolean, or an object of x/y/z or r/g/b/a numbers." },
        save: { type: "boolean", description: "Save the scene afterwards. Default false." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "godot_screenshot",
    description: "Capture the 2D or 3D editor viewport as an image, at most 960 px wide. Use it to check layout.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["2d", "3d"], description: "Which viewport. Default 2d." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "godot_log",
    description: "Tail of the game log (user://logs/godot.log) from the last play. Read it after play stops or the game errors.",
    inputSchema: {
      type: "object",
      properties: {
        lines: { type: "integer", minimum: 1, maximum: 80, description: "How many lines. Default 40." },
        errors_only: { type: "boolean", description: "Only errors and warnings with their location lines." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "godot_play",
    description: "Play the open scene, play the main scene, or stop the running game.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["play", "main", "stop"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "godot_refresh",
    description:
      "Rescan project files after writing them on disk. With scene, open that scene; if it is already open, reload it from disk and drop unsaved editor changes to it.",
    inputSchema: {
      type: "object",
      properties: {
        scene: { ...RES_PATH, description: "res:// scene path, forward slashes." },
      },
      additionalProperties: false,
    },
  },
];

const BRIDGE_PARAMS = {
  godot_status: () => ({}),
  godot_scene_tree: (args) => ({ depth: args.depth ?? 4, limit: args.limit ?? 80 }),
  godot_node: (args) => ({ path: args.path ?? ".", properties: args.properties ?? [] }),
  godot_set_property: (args) => ({ path: args.path ?? ".", property: args.property, value: args.value, save: args.save ?? false }),
  godot_screenshot: (args) => ({ view: args.view ?? "2d" }),
  godot_log: (args) => ({ lines: args.lines ?? 40, errors_only: args.errors_only ?? false }),
  godot_play: (args) => ({ action: args.action }),
  godot_refresh: (args) => ({ scene: args.scene ?? "" }),
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    write(rpcError(null, -32700, "Parse error"));
    return;
  }
  handleMessage(message)
    .then((response) => {
      if (response) write(response);
    })
    .catch((error) => {
      if (message.id === undefined || message.id === null) return;
      write(rpcError(message.id, -32603, errorText(error)));
    });
});

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(message) {
  if (!isPlainObject(message)) return null;
  const { id, method } = message;
  if (id === undefined || id === null) return null;

  if (method === "initialize") {
    const requested = message.params && message.params.protocolVersion;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    const params = message.params || {};
    return { jsonrpc: "2.0", id, result: await callTool(params.name, params.arguments ?? {}) };
  }
  return rpcError(id, -32601, `Unknown method: ${method}`);
}

function rpcError(id, code, text) {
  return { jsonrpc: "2.0", id, error: { code, message: text } };
}

async function callTool(name, args) {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) return toolError(`Unknown tool: ${name}`);
  const invalid = validateArgs(tool, args);
  if (invalid) return toolError(invalid);

  try {
    const projectDir = findProjectDir();
    const sessionPath = path.join(projectDir, ".claude-godot", "session.json");
    if (!fs.existsSync(sessionPath)) return toolError(missingBridge(projectDir));
    const session = readSession(sessionPath);
    const result = await bridgeCall(session, name.replace(/^godot_/, ""), BRIDGE_PARAMS[name](args));
    if (!isPlainObject(result)) return toolError("Godot returned an empty result");
    if (name === "godot_screenshot") return screenshotResult(session, result);
    if (name === "godot_status") addVersionWarning(result, projectDir);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return toolError(errorText(error));
  }
}

function missingBridge(projectDir) {
  return [
    `The Godot bridge is not running for ${projectDir}.`,
    `Install and enable the addon: node "${INSTALLER}" "${projectDir}"`,
    "Then restart the Godot editor. If the editor was open, enable Claude Godot in Project > Project Settings > Plugins.",
  ].join("\n");
}

function addVersionWarning(result, projectDir) {
  if (result.addon === VERSION) return;
  result.warning = `Addon ${result.addon ?? "0.1.x"} does not match plugin ${VERSION}. Update it: node "${INSTALLER}" "${projectDir}", then restart the editor.`;
}

function validateArgs(tool, args) {
  if (!isPlainObject(args)) return "Arguments must be an object";
  const { properties = {}, required = [] } = tool.inputSchema;
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) return `Unexpected argument: ${key}`;
  }
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) return `Missing argument: ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const problem = key === "value" ? checkSettable(value) : checkValue(key, properties[key], value);
    if (problem) return problem;
  }
  return "";
}

function checkValue(key, schema, value) {
  if (schema.enum) {
    return schema.enum.includes(value) ? "" : `${key} must be one of: ${schema.enum.join(", ")}`;
  }
  if (schema.type === "integer") {
    const ok = Number.isInteger(value) && value >= schema.minimum && value <= schema.maximum;
    return ok ? "" : `${key} must be an integer from ${schema.minimum} to ${schema.maximum}`;
  }
  if (schema.type === "boolean") {
    return typeof value === "boolean" ? "" : `${key} must be true or false`;
  }
  if (schema.type === "string") {
    if (typeof value !== "string" || value.length === 0 || value.length > schema.maxLength) {
      return `${key} must be a non-empty string up to ${schema.maxLength} characters`;
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${key} has an invalid format: ${value}`;
    return "";
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) {
      return `${key} must be a list of ${schema.minItems} to ${schema.maxItems} items`;
    }
    for (const item of value) {
      const problem = checkValue(key, schema.items, item);
      if (problem) return problem;
    }
  }
  return "";
}

function checkSettable(value) {
  if (typeof value === "string") return value.length <= 8192 ? "" : "value is longer than 8192 characters";
  if (typeof value === "number") return Number.isFinite(value) ? "" : "value must be a finite number";
  if (typeof value === "boolean") return "";
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const ok = keys.length > 0 && keys.every((key) => VALUE_KEYS.has(key) && Number.isFinite(value[key]));
    return ok ? "" : "value object may only hold numeric x, y, z or r, g, b, a";
  }
  return "value must be a string, number, boolean, or an object of x/y/z or r/g/b/a numbers";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function screenshotResult(session, result) {
  if (typeof result.file !== "string") return toolError("Godot did not return a screenshot file");
  const file = insideProject(session.project, result.file);
  const extension = path.extname(file).toLowerCase();
  const mimeType = extension === ".png" ? "image/png" : extension === ".jpg" ? "image/jpeg" : "";
  if (!mimeType) return toolError(`Unexpected screenshot type: ${file}`);
  const bytes = fs.readFileSync(file);
  const caption = { type: "text", text: `${result.view} viewport ${result.width}x${result.height}` };
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { content: [caption, { type: "text", text: `Image is ${bytes.length} bytes; it is on disk at ${file}` }] };
  }
  return { content: [caption, { type: "image", data: bytes.toString("base64"), mimeType }] };
}

function insideProject(project, file) {
  const target = path.resolve(file);
  const relative = path.relative(path.resolve(project), target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Godot returned a file outside the project");
  }
  if (!fs.existsSync(target)) throw new Error(`Screenshot file is missing: ${target}`);
  return target;
}

function findProjectDir() {
  if (process.env.GODOT_PROJECT) {
    const dir = path.resolve(process.env.GODOT_PROJECT);
    if (fs.existsSync(path.join(dir, "project.godot"))) return dir;
    throw new Error(`GODOT_PROJECT points to ${dir}, which has no project.godot`);
  }
  const seeds = [...new Set([process.env.CLAUDE_PROJECT_DIR, process.cwd()].filter(Boolean).map((seed) => path.resolve(seed)))];
  const candidates = [];
  for (const seed of seeds) {
    for (let dir = seed; ; dir = path.dirname(dir)) {
      if (isProject(dir)) candidates.push(dir);
      if (path.dirname(dir) === dir) break;
    }
  }
  for (const seed of seeds) candidates.push(...childProjects(seed));
  const running = candidates.find((dir) => fs.existsSync(path.join(dir, ".claude-godot", "session.json")));
  if (running) return running;
  if (candidates.length > 0) return candidates[0];
  throw new Error("No project.godot found in the working directory, its parents, or two levels below. Open Claude in the Godot project folder or set GODOT_PROJECT.");
}

function isProject(dir) {
  return fs.existsSync(path.join(dir, "project.godot"));
}

function childProjects(seed) {
  const found = [];
  let level = [seed];
  let scanned = 0;
  for (let depth = 0; depth < SEARCH_DEPTH && level.length > 0; depth += 1) {
    const next = [];
    for (const dir of level) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        if (scanned >= SEARCH_DIR_LIMIT) return found;
        scanned += 1;
        const child = path.join(dir, entry.name);
        if (isProject(child)) found.push(child);
        else next.push(child);
      }
    }
    level = next;
  }
  return found;
}

function readSession(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Could not read ${file}. Restart the Godot editor so the addon rewrites it.`);
  }
  const { port, token, project } = parsed;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The session file has no valid port. Restart the Godot editor.");
  if (typeof token !== "string" || !/^[a-f0-9]{16,128}$/i.test(token)) throw new Error("The session file has no valid token. Restart the Godot editor.");
  if (typeof project !== "string" || project.length === 0) throw new Error("The session file has no project path. Restart the Godot editor.");
  return { port, token, project: path.resolve(project) };
}

function bridgeCall(session, method, params) {
  const payload = `${JSON.stringify({ id: 1, token: session.token, method, params })}\n`;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: session.port });
    const chunks = [];
    let received = 0;
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error(`The Godot editor did not answer within ${BRIDGE_TIMEOUT_MS / 1000} seconds. Check that it is open and not stuck in a dialog.`)),
      BRIDGE_TIMEOUT_MS,
    );

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }

    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      const buffer = Buffer.concat(chunks, received);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        if (received > MAX_RESPONSE_BYTES) finish(new Error("The Godot response was too large"));
        return;
      }
      let message;
      try {
        message = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        finish(new Error("Godot returned invalid JSON"));
        return;
      }
      if (message.error) finish(new Error(String(message.error)));
      else finish(null, message.result);
    });
    socket.on("error", (error) => {
      if (error && error.code === "ECONNREFUSED") {
        finish(new Error(`Nothing listens on 127.0.0.1:${session.port}. The editor is closed or Claude Godot is disabled in Project Settings > Plugins.`));
        return;
      }
      finish(error instanceof Error ? error : new Error(String(error)));
    });
    socket.on("close", () => finish(new Error("Godot closed the connection without an answer")));
  });
}
