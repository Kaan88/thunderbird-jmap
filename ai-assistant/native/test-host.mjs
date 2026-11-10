// Test client for host.js: node native/test-host.mjs [ping|run|all]
import { spawn, execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const host = spawn(process.execPath, [path.join(dir, "host.js")], { stdio: ["pipe", "pipe", "inherit"] });
const handlers = new Map();
let buf = Buffer.alloc(0);
host.stdout.on("data", c => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    const m = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
    buf = buf.subarray(4 + n);
    (handlers.get(m.id) || (x => console.log("unhandled", x)))(m);
  }
});
function send(m) { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); host.stdin.write(Buffer.concat([h, b])); }
function run(msg, onMsg) {
  return new Promise(res => {
    handlers.set(msg.id, m => { onMsg && onMsg(m); if (m.type === "done" || m.type === "error" || m.type === "pong") { handlers.delete(msg.id); res(m); } });
    send(msg);
  });
}
const claudeProcs = () => { try { return execFileSync("tasklist", ["/FI", "IMAGENAME eq claude.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" }).split(/\r?\n/).filter(l => l.includes("claude.exe")).map(l => l.split('","')[1]); } catch { return []; } };

const mode = process.argv[2] || "all";
const pong = await run({ type: "ping", id: "p1" });
console.log("PING:", pong);

if (mode !== "ping") {
  const tools = [{ name: "echo", description: "Echoes text back", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
  const log = m => {
    if (m.type === "text") process.stdout.write(m.text);
    else if (m.type === "tool") { console.log("\nTOOL:", m.name, m.input); send({ type: "toolResult", id: m.id, callId: m.callId, content: "echo: " + (m.input.text ?? ""), isError: false }); }
    else if (m.type !== "turn") console.log("\n" + m.type.toUpperCase() + ":", JSON.stringify(m).slice(0, 400));
  };
  const d1 = await run({ type: "run", id: "r1", model: "haiku", system: "You are a test.", tools, prompt: "Call the echo tool with text 'hi', then answer with exactly the word done." }, log);
  if (d1.type === "done") {
    await run({ type: "run", id: "r2", model: "haiku", system: "You are a test.", tools, resume: d1.sessionId, prompt: "What did the tool return? One line." }, log);
  }
  const before = new Set(claudeProcs());
  let aborted = false;
  const r3 = await run({ type: "run", id: "r3", model: "haiku", system: "You are a test.", tools: [], prompt: "Write a 600-word story about a lighthouse." }, m => {
    if (m.type === "text" && !aborted) { aborted = true; console.log("\nfirst delta received, aborting"); send({ type: "abort", id: "r3" }); }
  });
  console.log("ABORT RESULT:", r3);
  await new Promise(r => setTimeout(r, 1500));
  const leftover = claudeProcs().filter(p => !before.has(p));
  console.log("new claude.exe still running after abort:", leftover.length ? leftover : "none");
}
host.stdin.end();
