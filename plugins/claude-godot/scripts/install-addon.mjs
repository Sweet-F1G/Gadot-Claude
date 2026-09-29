#!/usr/bin/env node
// Copy addons/claude_godot into a Godot project, enable it, and gitignore the local session file.
// Usage: node install-addon.mjs [project-dir] [--no-enable]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = "res://addons/claude_godot/plugin.cfg";
const IGNORE_LINE = ".claude-godot/";

const args = process.argv.slice(2);
const enable = !args.includes("--no-enable");
const target = args.find((arg) => !arg.startsWith("--"));

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(pluginRoot, "addons", "claude_godot");
const project = path.resolve(target || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const projectFile = path.join(project, "project.godot");

if (!fs.existsSync(source)) fail(`Addon source is missing: ${source}`);
if (!fs.existsSync(projectFile)) fail(`No project.godot in ${project}`);

const destination = path.join(project, "addons", "claude_godot");
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true });
console.log(`Installed ${destination}`);

const ignoreFile = path.join(project, ".gitignore");
const ignore = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, "utf8") : "";
if (!ignore.split(/\r?\n/).includes(IGNORE_LINE)) {
  const eol = ignore.includes("\r\n") ? "\r\n" : "\n";
  const prefix = ignore.length > 0 && !ignore.endsWith("\n") ? eol : "";
  fs.writeFileSync(ignoreFile, `${ignore}${prefix}${IGNORE_LINE}${eol}`);
}

if (enable) {
  const before = fs.readFileSync(projectFile, "utf8");
  const after = enablePlugin(before);
  if (after !== before) {
    fs.writeFileSync(projectFile, after);
    console.log("Enabled Claude Godot in project.godot.");
  }
  console.log("Restart the Godot editor. If it was open, check Project > Project Settings > Plugins: an open editor can overwrite project.godot.");
} else {
  console.log("In Godot: Project > Project Settings > Plugins > enable Claude Godot, then restart the editor.");
}

function enablePlugin(text) {
  if (text.includes(`"${ENTRY}"`)) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line) => line.trim() === "[editor_plugins]");
  const entryLine = `enabled=PackedStringArray("${ENTRY}")`;
  if (header === -1) {
    const body = text.length === 0 || text.endsWith("\n") ? text : `${text}${eol}`;
    return `${body}${eol}[editor_plugins]${eol}${eol}${entryLine}${eol}`;
  }
  let end = lines.findIndex((line, index) => index > header && line.startsWith("["));
  if (end === -1) end = lines.length;
  for (let index = header + 1; index < end; index += 1) {
    const match = lines[index].match(/^enabled=PackedStringArray\((.*)\)\s*$/);
    if (match) {
      const inner = match[1].trim();
      lines[index] = `enabled=PackedStringArray(${inner ? `${inner}, ` : ""}"${ENTRY}")`;
      return lines.join(eol);
    }
  }
  lines.splice(header + 1, 0, "", entryLine);
  return lines.join(eol);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
