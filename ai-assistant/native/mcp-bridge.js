#!/usr/bin/env node
// stdio MCP server launched by Claude Code; relays tool calls to host.js over TCP.
"use strict";
const net = require("net");
const [port, token] = process.argv.slice(2);
const err = (...a) => process.stderr.write("[mcp-bridge] " + a.join(" ") + "\n");

let tools = null;
const toolWaiters = [];
const pending = new Map();
let reqSeq = 0;

const sock = net.connect(Number(port), "127.0.0.1", () => sock.write(token + "\n"));
sock.setEncoding("utf8");
let sbuf = "";
sock.on("data", d => {
  sbuf += d;
  let i;
  while ((i = sbuf.indexOf("\n")) >= 0) {
    const line = sbuf.slice(0, i); sbuf = sbuf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "tools") { tools = m.tools || []; toolWaiters.splice(0).forEach(f => f()); }
    else if (m.type === "result") { const f = pending.get(m.reqId); if (f) { pending.delete(m.reqId); f(m); } }
  }
});
sock.on("error", e => err("socket error", e.message));
sock.on("close", () => {
  for (const f of pending.values()) f({ content: "Host connection closed", isError: true });
  pending.clear();
  if (!tools) { tools = []; toolWaiters.splice(0).forEach(f => f()); }
});

const getTools = () => tools ? Promise.resolve(tools) : new Promise(r => toolWaiters.push(() => r(tools)));
const out = m => process.stdout.write(JSON.stringify(m) + "\n");

async function handle(m) {
  const { id, method, params } = m;
  const isReq = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize":
        return out({ jsonrpc: "2.0", id, result: { protocolVersion: (params && params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "thunderbird", version: "1.0.0" } } });
      case "notifications/initialized": return;
      case "ping": return out({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return out({ jsonrpc: "2.0", id, result: { tools: await getTools() } });
      case "tools/call": {
        const reqId = ++reqSeq;
        const r = await new Promise(res => {
          if (sock.destroyed) return res({ content: "Host connection closed", isError: true });
          pending.set(reqId, res);
          sock.write(JSON.stringify({ type: "call", reqId, name: params.name, input: params.arguments || {} }) + "\n");
        });
        return out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(r.content ?? "") }], isError: !!r.isError } });
      }
      default:
        if (isReq) out({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    err(e.stack);
    if (isReq) out({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e) } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    handle(m);
  }
});
process.stdin.on("end", () => { sock.destroy(); process.exit(0); });
