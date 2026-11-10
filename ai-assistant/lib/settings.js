// Settings live in browser.storage.local under one key. API keys never leave
// this storage except in the request to the provider the user configured.

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";
export const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com/v1";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

import { CLAUDE_MODELS, claudeModelName } from "./claude-local.js";
import { CLAUDE_API_MODELS, hiddenKey, modelName } from "./models.js";

export const DEFAULTS = Object.freeze({
  defaultProvider: "openai", // "openai" | "anthropic" | "claude"
  openaiBaseUrl: "",
  openaiKey: "",
  openaiModel: "",
  anthropicBaseUrl: DEFAULT_ANTHROPIC_URL,
  anthropicKey: "",
  anthropicModel: DEFAULT_ANTHROPIC_MODEL,
  claudeLocal: false, // use the Claude Code CLI on this computer
  claudeModel: DEFAULT_CLAUDE_MODEL,
  claudePath: "",
  anthropicModelList: [], // [{ id, name }] fetched from the Models API
  hiddenModels: [], // ["anthropic:<id>", "claude:<id>"] left out of the panel
  effort: "", // "" (model default) | "low" | "medium" | "high" | "max"
  instructions: "",
  actions: "ask", // "off" | "ask" | "auto"
  lookups: true,
  prompts: "",
  translateTo: "English",
});

export async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}

export function trimUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

/** Providers the user has filled in enough to use. */
export function availableProviders(s) {
  const list = [];
  if (trimUrl(s.openaiBaseUrl) && (s.openaiModel || "").trim()) {
    list.push({
      id: "openai",
      label: "OpenAI-compatible",
      model: s.openaiModel.trim(),
      baseUrl: trimUrl(s.openaiBaseUrl),
    });
  }
  if (trimUrl(s.anthropicBaseUrl) && (s.anthropicKey || "").trim()) {
    // One entry per model, so the panel's menu is also the model picker.
    const chosen = (s.anthropicModel || "").trim() || DEFAULT_ANTHROPIC_MODEL;
    for (const model of visibleModels(s, "anthropic", anthropicModels(s).map(m => m.id), chosen)) {
      list.push({
        id: `anthropic:${model}`,
        kind: "anthropic",
        label: "Anthropic",
        title: `Anthropic · ${modelName(model, s.anthropicModelList)}`,
        model,
        baseUrl: trimUrl(s.anthropicBaseUrl),
      });
    }
  }
  if (s.claudeLocal) {
    const chosen = (s.claudeModel || "").trim() || DEFAULT_CLAUDE_MODEL;
    for (const model of visibleModels(s, "claude", CLAUDE_MODELS.map(m => m.id), chosen)) {
      list.push({
        id: `claude:${model}`,
        kind: "claude",
        local: true,
        label: "Claude on this computer",
        title: `Claude · ${claudeModelName(model)}`,
        model,
      });
    }
  }
  return list;
}

/** Models known for the Anthropic service: fetched list, else the built-in one. */
export function anthropicModels(s) {
  const fetched = Array.isArray(s.anthropicModelList) ? s.anthropicModelList : [];
  return fetched.length ? fetched : CLAUDE_API_MODELS;
}

// The models to show for a service: all known ones plus the chosen default,
// minus the hidden ones (the default stays if everything was hidden).
function visibleModels(s, service, known, chosen) {
  const hidden = new Set(Array.isArray(s.hiddenModels) ? s.hiddenModels : []);
  const all = known.includes(chosen) ? known : [chosen, ...known];
  const shown = all.filter(m => !hidden.has(hiddenKey(service, m)));
  return shown.length ? shown : [chosen];
}

export function pickProvider(s, preferred) {
  const list = availableProviders(s);
  const kind = p => p.kind || p.id;
  const defaultModel = {
    anthropic: (s.anthropicModel || "").trim() || DEFAULT_ANTHROPIC_MODEL,
    claude: (s.claudeModel || "").trim() || DEFAULT_CLAUDE_MODEL,
  }[s.defaultProvider];
  return (
    list.find(p => p.id == preferred) ||
    // An old pick like "anthropic" (before per-model entries) or a hidden model.
    list.find(p => preferred && kind(p) == preferred.split(":")[0] && p.model == defaultModel) ||
    list.find(p => preferred && kind(p) == preferred.split(":")[0]) ||
    list.find(p => kind(p) == s.defaultProvider && (!defaultModel || p.model == defaultModel)) ||
    list.find(p => kind(p) == s.defaultProvider) ||
    list[0] ||
    null
  );
}

/** Asks the Anthropic Models API which models the key can use. */
export async function fetchAnthropicModels(s) {
  const out = [];
  let after = "";
  for (let page = 0; page < 5; page++) {
    const url = `${trimUrl(s.anthropicBaseUrl)}/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
    const r = await fetch(url, {
      headers: {
        "x-api-key": (s.anthropicKey || "").trim(),
        "anthropic-version": "2026-10-21",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (!r.ok) {
      throw new Error(`The Models API answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const body = await r.json();
    for (const m of body.data || []) {
      out.push({ id: m.id, name: m.display_name || modelName(m.id) });
    }
    if (!body.has_more || !body.last_id) {
      break;
    }
    after = body.last_id;
  }
  return out;
}

/** "Name: what to ask" lines from the settings. */
export function savedPrompts(s) {
  return String(s.prompts || "")
    .split(/\r?\n/)
    .map(line => {
      const i = line.indexOf(":");
      if (i <= 0) {
        return null;
      }
      const name = line.slice(0, i).trim();
      const prompt = line.slice(i + 1).trim();
      return name && prompt ? { name, prompt } : null;
    })
    .filter(Boolean);
}

export function originPattern(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.hostname}/*`;
  } catch (e) {
    return null;
  }
}

/** True when the extension may talk to the provider's host. */
export async function hasHostAccess(baseUrl) {
  if (!baseUrl) {
    return true; // local provider, nothing to reach over the network
  }
  const origin = originPattern(baseUrl);
  if (!origin) {
    return false;
  }
  return browser.permissions.contains({ origins: [origin] });
}

/** Must be called from a click handler (user gesture). */
export async function requestHostAccess(baseUrl) {
  const origin = originPattern(baseUrl);
  if (!origin) {
    return false;
  }
  return browser.permissions.request({ origins: [origin] });
}
