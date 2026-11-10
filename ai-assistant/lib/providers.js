// Chat clients for an OpenAI-compatible service and for Anthropic's Messages
// API, both streaming, both with tool calls.
//
// Neutral history entries:
//   { role: "user", text }
//   { role: "assistant", text, toolCalls: [{ id, name, args }], raw }
//   { role: "tool", results: [{ id, name, content, isError }] }
// `raw` keeps Anthropic's content blocks (thinking blocks included) so they can
// be passed back unchanged, as the API requires.

import { runClaudeLocal } from "./claude-local.js";
import { supportsEffort } from "./models.js";

const ANTHROPIC_VERSION = "2026-10-21";
const MAX_TOKENS = 16000;

// Models that turned out not to take tools on this run (some Ollama models).
const noToolModels = new Set();

export class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// A stream that sends nothing for this long has stalled (thinking models
// still send pings or thinking deltas meanwhile).
const IDLE_MS = 180000;

async function readWithin(reader, ms) {
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new ProviderError(`The AI service stopped sending anything for ${ms / 60000} minutes. Try again.`));
    }, ms);
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

async function* readSSE(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) {
        throw new DOMException("Stopped", "AbortError");
      }
      const { value, done } = await readWithin(reader, IDLE_MS);
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let i;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const data = chunk
          .split("\n")
          .filter(l => l.startsWith("data:"))
          .map(l => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) {
          yield data;
        }
      }
    }
    const rest = buffer
      .split("\n")
      .filter(l => l.startsWith("data:"))
      .map(l => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (rest) {
      yield rest;
    }
  } finally {
    reader.releaseLock();
  }
}

async function errorFrom(response) {
  let text = "";
  try {
    text = await response.text();
  } catch (e) {}
  let message = text;
  try {
    const json = JSON.parse(text);
    message = json.error?.message || json.message || json.error || text;
  } catch (e) {}
  if (typeof message != "string") {
    message = JSON.stringify(message);
  }
  message = (message || response.statusText || "Request failed").slice(0, 500);
  return new ProviderError(`${response.status}: ${message}`, response.status);
}

function newId() {
  return "call_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

// ---------------------------------------------------------------- Anthropic

function toAnthropicMessages(history, { stripThinking = false } = {}) {
  const out = [];
  const push = (role, content) => {
    const last = out[out.length - 1];
    if (last && last.role == role && role == "user") {
      const a = typeof last.content == "string" ? [{ type: "text", text: last.content }] : last.content;
      const b = typeof content == "string" ? [{ type: "text", text: content }] : content;
      last.content = [...a, ...b];
    } else {
      out.push({ role, content });
    }
  };
  for (const h of history) {
    if (h.role == "user") {
      push("user", h.text);
    } else if (h.role == "assistant") {
      let content;
      if (h.raw?.provider == "anthropic") {
        content = h.raw.content;
        if (stripThinking) {
          content = content.filter(b => b.type != "thinking" && b.type != "redacted_thinking");
        }
      } else {
        content = [];
        if (h.text) {
          content.push({ type: "text", text: h.text });
        }
        for (const c of h.toolCalls || []) {
          content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args || {} });
        }
      }
      if (!content.length) {
        content = [{ type: "text", text: "(no answer)" }];
      }
      out.push({ role: "assistant", content });
    } else if (h.role == "tool") {
      push(
        "user",
        h.results.map(r => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        }))
      );
    }
  }
  return out;
}

async function anthropicRequest({ provider, apiKey, system, history, tools, onText, signal, stripThinking, effort }) {
  const body = {
    model: provider.model,
    max_tokens: MAX_TOKENS,
    stream: true,
    system,
    messages: toAnthropicMessages(history, { stripThinking }),
  };
  if (effort && supportsEffort(provider.model)) {
    body.output_config = { effort };
  }
  if (tools?.length) {
    body.tools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  const response = await fetch(`${provider.baseUrl}/messages`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await errorFrom(response);
  }

  const blocks = [];
  const json = [];
  let stopReason = null;
  let wroteText = false;
  for await (const data of readSSE(response, signal)) {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch (e) {
      continue;
    }
    switch (ev.type) {
      case "content_block_start": {
        const block = structuredClone(ev.content_block);
        if (block.type == "text") {
          block.text = block.text || "";
          if (wroteText) {
            onText?.("\n\n");
          }
        }
        if (block.type == "tool_use") {
          json[ev.index] = "";
        }
        blocks[ev.index] = block;
        break;
      }
      case "content_block_delta": {
        const block = blocks[ev.index];
        const d = ev.delta || {};
        if (!block) {
          break;
        }
        if (d.type == "text_delta") {
          block.text += d.text;
          wroteText = true;
          onText?.(d.text);
        } else if (d.type == "input_json_delta") {
          json[ev.index] += d.partial_json;
        } else if (d.type == "thinking_delta") {
          block.thinking = (block.thinking || "") + d.thinking;
        } else if (d.type == "signature_delta") {
          block.signature = (block.signature || "") + d.signature;
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks[ev.index];
        if (block?.type == "tool_use") {
          try {
            block.input = json[ev.index] ? JSON.parse(json[ev.index]) : {};
          } catch (e) {
            block.input = {};
            block._invalid = true;
          }
        }
        break;
      }
      case "message_delta":
        stopReason = ev.delta?.stop_reason ?? stopReason;
        break;
      case "error":
        throw new ProviderError(ev.error?.message || "The service reported an error.");
    }
  }

  const content = blocks.filter(Boolean);
  if (stopReason == "refusal") {
    throw new ProviderError("The model declined to answer this request.");
  }
  const toolCalls = content
    .filter(b => b.type == "tool_use")
    .map(b => ({ id: b.id, name: b.name, args: b.input, invalid: !!b._invalid }));
  content.forEach(b => delete b._invalid);
  return {
    turn: {
      role: "assistant",
      text: content.filter(b => b.type == "text").map(b => b.text).join("\n\n"),
      toolCalls,
      raw: { provider: "anthropic", content },
    },
    stopReason,
  };
}

async function anthropicChat(opts) {
  try {
    return await anthropicRequest(opts);
  } catch (e) {
    // Edited history can invalidate earlier thinking blocks: retry once
    // without them (the model answers without that earlier reasoning).
    if (e.status == 400 && /thinking/i.test(e.message) && !opts.stripThinking) {
      return anthropicChat({ ...opts, stripThinking: true });
    }
    // A model or gateway that doesn't know this effort level: use its default.
    if (e.status == 400 && /effort|output_config/i.test(e.message) && opts.effort) {
      return anthropicChat({ ...opts, effort: "" });
    }
    throw e;
  }
}

// ---------------------------------------------------------------- OpenAI

function toOpenAIMessages(system, history) {
  const out = [{ role: "system", content: system }];
  for (const h of history) {
    if (h.role == "user") {
      out.push({ role: "user", content: h.text });
    } else if (h.role == "assistant") {
      const msg = { role: "assistant", content: h.text || "" };
      if (h.toolCalls?.length) {
        msg.tool_calls = h.toolCalls.map(c => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        }));
      }
      out.push(msg);
    } else if (h.role == "tool") {
      for (const r of h.results) {
        out.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
    }
  }
  return out;
}

// Hides <think>…</think> output of reasoning models served through Ollama.
function makeThinkFilter(onText) {
  let inThink = false;
  let pending = "";
  const filter = chunk => {
    pending += chunk;
    let visible = "";
    for (;;) {
      if (inThink) {
        const end = pending.indexOf("</think>");
        if (end < 0) {
          pending = pending.slice(-8);
          break;
        }
        pending = pending.slice(end + 8);
        inThink = false;
      } else {
        const start = pending.indexOf("<think>");
        if (start < 0) {
          // hold back a possible partial "<think>" at the end
          let hold = 0;
          for (let k = Math.min(6, pending.length); k > 0; k--) {
            if ("<think>".startsWith(pending.slice(-k))) {
              hold = k;
              break;
            }
          }
          visible += pending.slice(0, pending.length - hold);
          pending = pending.slice(pending.length - hold);
          break;
        }
        visible += pending.slice(0, start);
        pending = pending.slice(start + 7);
        inThink = true;
      }
    }
    if (visible) {
      onText?.(visible);
    }
    return visible;
  };
  filter.flush = () => {
    const rest = inThink ? "" : pending;
    pending = "";
    if (rest) {
      onText?.(rest);
    }
    return rest;
  };
  return filter;
}

async function openaiRequest({ provider, apiKey, system, history, tools, onText, signal }) {
  const useTools = tools?.length && !noToolModels.has(provider.baseUrl + "|" + provider.model);
  const body = {
    model: provider.model,
    stream: true,
    messages: toOpenAIMessages(system, history),
  };
  if (useTools) {
    body.tools = tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  const headers = { "content-type": "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await errorFrom(response);
    if (useTools && response.status == 400 && /tool/i.test(err.message)) {
      noToolModels.add(provider.baseUrl + "|" + provider.model);
      return openaiRequest({ provider, apiKey, system, history, tools, onText, signal });
    }
    throw err;
  }

  let text = "";
  const calls = [];
  let stopReason = null;
  const filter = makeThinkFilter(onText);
  for await (const data of readSSE(response, signal)) {
    if (data.trim() == "[DONE]") {
      break;
    }
    let ev;
    try {
      ev = JSON.parse(data);
    } catch (e) {
      continue;
    }
    if (ev.error) {
      throw new ProviderError(ev.error.message || String(ev.error));
    }
    const choice = ev.choices?.[0];
    if (!choice) {
      continue;
    }
    const d = choice.delta || choice.message || {};
    if (typeof d.content == "string" && d.content) {
      text += filter(d.content);
    }
    for (const tc of d.tool_calls || []) {
      const idx = tc.index ?? calls.length;
      const c = (calls[idx] ||= { id: "", name: "", args: "" });
      if (tc.id) {
        c.id = tc.id;
      }
      if (tc.function?.name) {
        c.name += tc.function.name;
      }
      if (tc.function?.arguments) {
        c.args +=
          typeof tc.function.arguments == "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments);
      }
    }
    if (choice.finish_reason) {
      stopReason = choice.finish_reason;
    }
  }
  text += filter.flush();
  const toolCalls = calls.filter(Boolean).map(c => {
    let args = {};
    let invalid = false;
    try {
      args = c.args ? JSON.parse(c.args) : {};
    } catch (e) {
      invalid = true;
    }
    return { id: c.id || newId(), name: c.name, args, invalid };
  });
  return {
    turn: { role: "assistant", text: text.trim(), toolCalls, raw: { provider: "openai" } },
    stopReason,
  };
}

/**
 * One model turn. Returns { turn, stopReason }.
 */
export async function chat({ settings, provider, system, history, tools, onText, signal }) {
  if ((provider.kind || provider.id) == "anthropic") {
    return anthropicChat({
      provider,
      effort: settings.effort || "",
      apiKey: settings.anthropicKey.trim(),
      system,
      history,
      tools,
      onText,
      signal,
    });
  }
  return openaiRequest({
    provider,
    apiKey: (settings.openaiKey || "").trim(),
    system,
    history,
    tools,
    onText,
    signal,
  });
}

/**
 * Runs model turns and tool calls until the model answers in text.
 * `runTool(call)` returns { content, isError }.
 * Events: onText(chunk), onTurnStart(), onTool(call, phase, result).
 */
export async function runAgent({
  settings,
  provider,
  system,
  history,
  tools,
  runTool,
  onText,
  onTurnStart,
  signal,
  maxSteps = 30,
}) {
  if (provider.kind == "claude") {
    return runClaudeLocal({ settings, provider, system, history, tools, runTool, onText, onTurnStart, signal });
  }
  for (let step = 0; step < maxSteps; step++) {
    onTurnStart?.(step);
    const { turn } = await chat({ settings, provider, system, history, tools, onText, signal });
    history.push(turn);
    if (!turn.toolCalls.length) {
      return turn;
    }
    const results = [];
    for (const call of turn.toolCalls) {
      if (signal?.aborted) {
        results.push({ id: call.id, name: call.name, content: "Stopped by the user.", isError: true });
        continue;
      }
      let result;
      if (call.invalid) {
        result = { content: "The tool input was not valid JSON. Try again.", isError: true };
      } else {
        try {
          result = await runTool(call);
        } catch (e) {
          result = { content: `Failed: ${e.message || e}`, isError: true };
        }
      }
      results.push({ id: call.id, name: call.name, content: String(result.content), isError: !!result.isError });
    }
    history.push({ role: "tool", results });
    if (signal?.aborted) {
      throw new DOMException("Stopped", "AbortError");
    }
  }
  const final = {
    role: "assistant",
    text: "I stopped here because this took too many steps. Ask again more specifically?",
    toolCalls: [],
    raw: { provider: "local" },
  };
  history.push(final);
  return final;
}

/** A single prompt with no tools and no history; returns the text. */
export async function complete({ settings, provider, system, prompt, onText, signal }) {
  const history = [{ role: "user", text: prompt }];
  if (provider.kind == "claude") {
    const turn = await runClaudeLocal({ settings, provider, system, history, tools: [], runTool: async () => ({ content: "No tools here.", isError: true }), onText, signal });
    return turn.text;
  }
  const { turn } = await chat({ settings, provider, system, history, tools: [], onText, signal });
  return turn.text;
}
