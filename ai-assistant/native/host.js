#!/usr/bin/env node
// Native-messaging host: bridges the Thunderbird AI Assistant extension to the Claude Code CLI.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawn, execFile, execFileSync } = require("child_process");

const LOG = path.join(os.tmpdir(), "ai-assistant-host.log");
try { if (fs.statSync(LOG).size > 512 * 1024) fs.truncateSync(LOG, 0); } catch {}
function log(...a) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}\n`); } catch {}
}

// ---- framing ----
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([hdr, body]));
}
let inBuf = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + len) break;
    const body = inBuf.subarray(4, 4 + len).toString("utf8");
    inBuf = inBuf.subarray(4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch (e) { log("bad json", e.message); continue; }
    try { handle(msg); } catch (e) { log("handler error", e.stack); if (msg && msg.id) failRun(msg.id, String(e.message || e)); }
  }
});
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("stdin closed, shutting down");
  for (const run of runs.values()) killRun(run);
  setTimeout(() => process.exit(0), 1500);
}

// ---- claude path ----
function resolveClaude(p) {
  if (p && fs.existsSync(p)) return p;
  try {
    const out = execFileSync("where", ["claude"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const exe = lines.find(l => /\.exe$/i.test(l)) || lines[0];
    if (exe) return exe;
  } catch {}
  return path.join(process.env.USERPROFILE || os.homedir(), ".local", "bin", "claude.exe");
}

// ---- runs ----
const runs = new Map();

function handle(msg) {
  switch (msg.type) {
    case "ping": return ping(msg);
    case "run": return startRun(msg);
    case "toolResult": {
      const run = runs.get(msg.id);
      const pend = run && run.pendingTools.get(msg.callId);
      if (!pend) return log("toolResult for unknown call", msg.id, msg.callId);
      run.pendingTools.delete(msg.callId);
      pend({ content: String(msg.content ?? ""), isError: !!msg.isError });
      return;
    }
    case "abort": {
      const run = runs.get(msg.id);
      if (run) { run.aborted = true; killRun(run); finishRun(run, { type: "error", id: run.id, message: "aborted" }); }
      return;
    }
    default: log("unknown message type", msg.type);
  }
}

function ping(msg) {
  const claudePath = resolveClaude(msg.claudePath);
  execFile(claudePath, ["--version"], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
    if (err) send({ type: "pong", id: msg.id, ok: false, message: `${err.message}\n${(stderr || "").slice(-1000)}`, claudePath });
    else send({ type: "pong", id: msg.id, ok: true, version: stdout.trim(), claudePath, node: process.version });
  });
}

function failRun(id, message) {
  const run = runs.get(id);
  if (run) { killRun(run); finishRun(run, { type: "error", id, message }); }
  else send({ type: "error", id, message });
}

function finishRun(run, finalMsg) {
  if (run.finished) return;
  run.finished = true;
  if (finalMsg) send(finalMsg);
  for (const pend of run.pendingTools.values()) pend({ content: "Run ended", isError: true });
  run.pendingTools.clear();
  if (run.server) try { run.server.close(); } catch {}
  for (const s of run.sockets) try { s.destroy(); } catch {}
  runs.delete(run.id);
  setTimeout(() => { try { fs.rmSync(run.tmp, { recursive: true, force: true }); } catch (e) { log("cleanup", e.message); } }, 2000);
}

function killRun(run) {
  const p = run.proc;
  if (!p || p.exitCode !== null || run.killed) return;
  run.killed = true;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
  } else {
    try { p.kill("SIGKILL"); } catch {}
  }
}

function startBridgeServer(run) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(sock => {
      run.sockets.add(sock);
      sock.on("close", () => run.sockets.delete(sock));
      sock.on("error", () => {});
      let buf = "", authed = false;
      sock.setEncoding("utf8");
      sock.on("data", d => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          if (!authed) {
            if (line !== run.token) { log("bad bridge token"); sock.destroy(); return; }
            authed = true;
            sock.write(JSON.stringify({ type: "tools", tools: run.tools }) + "\n");
            continue;
          }
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.type === "call") {
            const callId = "call_" + crypto.randomBytes(6).toString("hex");
            const reply = r => { try { sock.write(JSON.stringify({ type: "result", reqId: m.reqId, ...r }) + "\n"); } catch {} };
            if (run.finished) { reply({ content: "Run ended", isError: true }); continue; }
            run.pendingTools.set(callId, reply);
            send({ type: "tool", id: run.id, callId, name: m.name, input: m.input || {} });
          }
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function startRun(msg) {
  const id = msg.id;
  if (runs.has(id)) return send({ type: "error", id, message: "run id already active" });
  const run = {
    id, tools: (msg.tools || []).map(t => ({ name: t.name, description: t.description || "", inputSchema: t.input_schema || t.inputSchema || { type: "object", properties: {} } })),
    pendingTools: new Map(), sockets: new Set(), finished: false, killed: false, aborted: false,
    token: crypto.randomBytes(24).toString("hex"), sessionId: null, stderr: "", gotResult: false,
  };
  run.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-assistant-run-"));
  runs.set(id, run);
  const cwd = path.join(run.tmp, "cwd");
  fs.mkdirSync(cwd);

  const sysFile = path.join(run.tmp, "system.txt");
  fs.writeFileSync(sysFile, msg.system || "", "utf8");

  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--system-prompt-file", sysFile,
    "--tools", "",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--strict-mcp-config"];
  if (msg.model && msg.model !== "default") args.push("--model", msg.model);
  if (["low", "medium", "high", "xhigh", "max"].includes(msg.effort)) args.push("--effort", msg.effort);
  if (msg.resume) args.push("--resume", msg.resume);
  if (run.tools.length) {
    run.server = await startBridgeServer(run);
    if (run.finished) return;
    const port = run.server.address().port;
    const mcpFile = path.join(run.tmp, "mcp.json");
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { thunderbird: { type: "stdio", command: process.execPath, args: [path.join(__dirname, "mcp-bridge.js"), String(port), run.token] } } }), "utf8");
    args.push("--mcp-config", mcpFile, "--allowedTools", "mcp__thunderbird");
  }

  const claudePath = resolveClaude(msg.claudePath);
  log("run", id, claudePath, args.join(" "));
  const env = { ...process.env, MCP_TOOL_TIMEOUT: "3600000", MCP_TIMEOUT: "60000" };
  let proc;
  try {
    proc = spawn(claudePath, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) { return finishRun(run, { type: "error", id, message: `spawn failed: ${e.message}` }); }
  run.proc = proc;
  proc.on("error", e => finishRun(run, { type: "error", id, message: `spawn failed (${claudePath}): ${e.message}` }));
  proc.stdin.on("error", () => {});
  proc.stdin.end(msg.prompt || "", "utf8");
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", d => { run.stderr = (run.stderr + d).slice(-4000); });

  let out = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", d => {
    out += d;
    let i;
    while ((i = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, i).trim(); out = out.slice(i + 1);
      if (line) onLine(run, line);
    }
  });
  proc.on("close", code => {
    if (out.trim()) onLine(run, out.trim());
    log("exit", id, code);
    if (!run.finished) {
      const tail = run.stderr.trim().slice(-1500);
      finishRun(run, { type: "error", id, message: run.aborted ? "aborted" : `claude exited with code ${code} without a result${tail ? ":\n" + tail : ""}` });
    }
  });
}

function onLine(run, line) {
  if (run.finished) return;
  let ev; try { ev = JSON.parse(line); } catch { run.stderr = (run.stderr + "\n" + line).slice(-4000); return; }
  if (ev.session_id && !run.sessionId) {
    run.sessionId = ev.session_id;
    send({ type: "session", id: run.id, sessionId: run.sessionId });
  }
  if (ev.type === "stream_event" && ev.event) {
    const e = ev.event;
    if (e.type === "message_start") send({ type: "turn", id: run.id });
    else if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta") send({ type: "text", id: run.id, text: e.delta.text });
  } else if (ev.type === "result") {
    run.gotResult = true;
    const isError = !!ev.is_error || (ev.subtype && ev.subtype !== "success");
    let result = ev.result;
    if (isError && !result) result = (ev.errors && ev.errors.join("\n")) || ev.subtype || run.stderr.slice(-1500);
    finishRun(run, { type: "done", id: run.id, sessionId: ev.session_id || run.sessionId, result: result ?? "", isError, usage: ev.usage });
  }
}

process.on("uncaughtException", e => log("uncaught", e.stack));
log("host started", process.version);
