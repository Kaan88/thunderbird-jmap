// "Claude on this computer": runs the Claude Code CLI the user already has,
// through the native-messaging helper in native/ (install it with
// native\install.ps1). The CLI uses the user's own Claude login; no API key is
// stored here. The assistant's tools reach Claude through an MCP bridge, and
// every tool call still goes through runTool (and its approval cards).

export const CLAUDE_HOST = "ai_assistant_claude";

export const CLAUDE_MODELS = [
  { id: "claude-fable-5-1", name: "Fable 5.1" },
  { id: "claude-opus-5-5", name: "Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Haiku 5.5" },
  { id: "default", name: "Claude Code default" },
];

export function claudeModelName(id) {
  return CLAUDE_MODELS.find(m => m.id == id)?.name || id;
}

class ClaudeLocalError extends Error {}

function notInstalled(port) {
  const msg = port?.error?.message || "";
  return new ClaudeLocalError(
    /no such native application|not found|manifest/i.test(msg)
      ? (/win/i.test(navigator.platform)
        ? "The helper for Claude on this computer isn't installed. Run native\\install.ps1 from the add-on's source folder (see README), then restart Thunderbird."
        : "The helper for Claude on this computer isn't installed. Run native/install.sh from the add-on's source folder (see README; the Thunderbird-JMAP AppImage does this for you at start), then restart Thunderbird.")
      : `The Claude helper stopped${msg ? `: ${msg}` : "."}`
  );
}

let nextId = 1;

/** Asks the helper for the installed Claude Code version. */
export function claudePing(claudePath) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = browser.runtime.connectNative(CLAUDE_HOST);
    } catch (e) {
      reject(notInstalled({ error: e }));
      return;
    }
    const id = `ping${nextId++}`;
    let settled = false;
    port.onMessage.addListener(msg => {
      if (msg.id != id) return;
      settled = true;
      port.disconnect();
      msg.ok ? resolve(msg) : reject(new ClaudeLocalError(msg.message || "Claude Code didn't answer."));
    });
    port.onDisconnect.addListener(p => {
      if (!settled) reject(notInstalled(p));
    });
    port.postMessage({ type: "ping", id, claudePath: claudePath || undefined });
  });
}

// Earlier turns as plain text, for a conversation Claude hasn't seen yet
// (started with another service, or the session can't be resumed).
function transcript(history) {
  const out = [];
  for (const h of history) {
    if (h.role == "user") {
      out.push(`<user>\n${h.text}\n</user>`);
    } else if (h.role == "assistant" && h.text) {
      out.push(`<assistant>\n${h.text}\n</assistant>`);
    } else if (h.role == "tool") {
      for (const r of h.results || []) {
        out.push(`<tool_result name="${r.name}">\n${String(r.content).slice(0, 4000)}\n</tool_result>`);
      }
    }
  }
  return out.join("\n\n");
}

function promptFor(history, noResume) {
  const last = history[history.length - 1];
  const earlier = history.slice(0, -1);
  // Resume the CLI session when the last answer came from it.
  let lastAssistant = -1;
  for (let i = earlier.length - 1; i >= 0; i--) {
    if (earlier[i].role == "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const session = lastAssistant >= 0 ? earlier[lastAssistant].raw?.claudeSession : null;
  if (session && !noResume && lastAssistant == earlier.length - 1) {
    return { prompt: last.text, resume: session };
  }
  if (!earlier.length) {
    return { prompt: last.text };
  }
  return {
    prompt: `Earlier in this conversation:\n\n${transcript(earlier)}\n\nThe user now says:\n${last.text}`,
  };
}

/**
 * Runs one request through Claude Code, with tools. Appends the answer to
 * `history` and returns it, like runAgent.
 */
export async function runClaudeLocal(opts) {
  try {
    return await runOnce(opts, false);
  } catch (e) {
    const resumed = !!promptFor(opts.history).resume;
    if (!resumed || e.name == "AbortError" || !/session|conversation|resume/i.test(e.message)) {
      throw e;
    }
    return runOnce(opts, true);
  }
}

function runOnce({ settings, provider, system, history, tools, runTool, onText, onTurnStart, signal }, noResume) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = browser.runtime.connectNative(CLAUDE_HOST);
    } catch (e) {
      reject(notInstalled({ error: e }));
      return;
    }
    const id = `run${nextId++}`;
    let text = "";
    let step = -1;
    let sessionId = null;
    let finished = false;

    const finish = (err, turn) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      try {
        port.disconnect();
      } catch (e) {}
      if (err) {
        reject(err);
      } else {
        history.push(turn);
        resolve(turn);
      }
    };
    const onAbort = () => {
      try {
        port.postMessage({ type: "abort", id });
      } catch (e) {}
      finish(new DOMException("Stopped", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);

    port.onDisconnect.addListener(p => finish(notInstalled(p)));
    port.onMessage.addListener(async msg => {
      if (msg.id != id || finished) return;
      switch (msg.type) {
        case "session":
          sessionId = msg.sessionId;
          break;
        case "turn":
          step++;
          onTurnStart?.(step);
          if (step > 0 && text && !text.endsWith("\n")) {
            text += "\n\n";
          }
          break;
        case "text":
          text += msg.text;
          onText?.(msg.text);
          break;
        case "tool": {
          let result;
          try {
            result = await runTool({ id: msg.callId, name: msg.name, args: msg.input || {} });
          } catch (e) {
            result = { content: `Failed: ${e.message || e}`, isError: true };
          }
          if (!finished) {
            port.postMessage({
              type: "toolResult",
              id,
              callId: msg.callId,
              content: String(result?.content ?? ""),
              isError: !!result?.isError,
            });
          }
          break;
        }
        case "done":
          if (msg.isError && !text) {
            finish(new ClaudeLocalError(msg.result || "Claude Code reported an error."));
            break;
          }
          finish(null, {
            role: "assistant",
            text: text || msg.result || "",
            toolCalls: [],
            raw: { provider: "claude", claudeSession: msg.sessionId || sessionId },
          });
          break;
        case "error":
          finish(new ClaudeLocalError(msg.message || "Claude Code failed."));
          break;
      }
    });

    const { prompt, resume } = promptFor(history, noResume);
    port.postMessage({
      type: "run",
      id,
      prompt,
      resume,
      system,
      model: provider.model && provider.model != "default" ? provider.model : undefined,
      effort: settings.effort || undefined,
      claudePath: settings.claudePath || undefined,
      tools: (tools || []).map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    });
  });
}
