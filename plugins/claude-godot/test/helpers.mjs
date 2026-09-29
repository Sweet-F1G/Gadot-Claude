import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const serverPath = path.join(pluginRoot, "mcp", "server.mjs");
export const installerPath = path.join(pluginRoot, "scripts", "install-addon.mjs");

export function tempProject(projectGodot = "; Engine configuration file.\nconfig_version=5\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-godot-"));
  fs.writeFileSync(path.join(dir, "project.godot"), projectGodot);
  return dir;
}

export function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function startServer(env) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let nextId = 1;
  const waiters = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      }
      newline = buffer.indexOf("\n");
    }
  });

  function request(method, params, timeoutMs = 15000) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  return {
    request,
    async tool(name, args = {}) {
      const message = await request("tools/call", { name, arguments: args });
      return message.result;
    },
    stop() {
      child.kill();
    },
  };
}

export function toolJson(result) {
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}
