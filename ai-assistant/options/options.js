import {
  DEFAULTS,
  anthropicModels,
  fetchAnthropicModels,
  getSettings,
  originPattern,
  pickProvider,
  saveSettings,
  trimUrl,
} from "../lib/settings.js";
import { CLAUDE_MODELS } from "../lib/claude-local.js";
import { hiddenKey, modelName } from "../lib/models.js";
import { complete } from "../lib/providers.js";
import { claudePing } from "../lib/claude-local.js";

const form = document.getElementById("form");
const status = document.getElementById("status");

function readForm() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const el = form.elements[key];
    if (!el) {
      continue;
    }
    out[key] = el.type == "checkbox" ? el.checked : el.value.trim();
  }
  out.hiddenModels = [...document.querySelectorAll(".model-list input[type=checkbox]")]
    .filter(box => !box.checked)
    .map(box => box.dataset.key);
  out.openaiBaseUrl = trimUrl(out.openaiBaseUrl);
  out.anthropicBaseUrl = trimUrl(out.anthropicBaseUrl);
  return out;
}

function fillForm(s) {
  for (const key of Object.keys(DEFAULTS)) {
    const el = form.elements[key];
    if (!el) {
      continue;
    }
    if (el.type == "checkbox") {
      el.checked = !!s[key];
    } else {
      el.value = s[key] ?? "";
    }
  }
}

function originsFor(s) {
  return [s.openaiBaseUrl, s.anthropicBaseUrl]
    .filter(Boolean)
    .map(originPattern)
    .filter(Boolean);
}

form.addEventListener("submit", e => {
  e.preventDefault();
  const values = readForm();
  const origins = originsFor(values);
  // Ask for access to the configured hosts while the click still counts.
  const granted = origins.length
    ? browser.permissions.request({ origins }).catch(() => false)
    : Promise.resolve(true);
  (async () => {
    await saveSettings(values);
    const ok = await granted;
    status.textContent = ok
      ? "Saved."
      : "Saved. Thunderbird was not allowed to contact the service yet; the assistant will ask again.";
    setTimeout(() => (status.textContent = ""), 6000);
  })();
});

for (const button of document.querySelectorAll(".reveal")) {
  button.addEventListener("click", () => {
    const input = button.previousElementSibling;
    input.type = input.type == "password" ? "text" : "password";
    button.textContent = input.type == "password" ? "Show" : "Hide";
  });
}

for (const button of document.querySelectorAll("[data-test]")) {
  button.addEventListener("click", () => {
    const id = button.dataset.test;
    const out = document.getElementById(`test-${id}`);
    const values = readForm();
    if (id == "claude") {
      testClaude(values, out);
      return;
    }
    const provider = pickProvider(values, id);
    if (!provider || (provider.kind || provider.id) != id) {
      out.className = "test-result bad";
      out.textContent =
        id == "anthropic" ? "Fill in the address and the key first." : "Fill in the address and the model first.";
      return;
    }
    const origin = originPattern(provider.baseUrl);
    const granted = browser.permissions.request({ origins: [origin] }).catch(() => false);
    out.className = "test-result";
    out.textContent = "Testing…";
    (async () => {
      if (!(await granted)) {
        out.className = "test-result bad";
        out.textContent = "Thunderbird was not allowed to contact this address.";
        return;
      }
      try {
        const text = await complete({
          settings: values,
          provider,
          system: "You are a connection test.",
          prompt: "Reply with the single word OK.",
        });
        out.className = "test-result ok";
        out.textContent = `Works (${provider.model} said: ${String(text).trim().slice(0, 40) || "nothing"}).`;
      } catch (e) {
        out.className = "test-result bad";
        out.textContent = String(e.message || e);
      }
    })();
  });
}

async function testClaude(values, out) {
  out.className = "test-result";
  out.textContent = "Looking for Claude Code…";
  try {
    const info = await claudePing(values.claudePath);
    out.textContent = `Found ${info.version}. Asking ${values.claudeModel || "the default model"}…`;
    const provider = { id: "claude", kind: "claude", model: values.claudeModel || "default" };
    const text = await complete({
      settings: values,
      provider,
      system: "You are a connection test.",
      prompt: "Reply with the single word OK.",
    });
    out.className = "test-result ok";
    out.textContent = `Works: ${info.version}, ${provider.model} said “${String(text).trim().slice(0, 40)}”.`;
  } catch (e) {
    out.className = "test-result bad";
    out.textContent = String(e.message || e);
  }
}

const instructions = form.elements.instructions;
const count = document.getElementById("instructions-count");
const updateCount = () => {
  const n = instructions.value.length;
  count.textContent = n ? `${n.toLocaleString()} characters.` : "";
};
instructions.addEventListener("input", updateCount);

// Model checklists: ticked = shown in the panel's menu.
let current = { ...DEFAULTS };
function fillModels(s) {
  const hidden = new Set(s.hiddenModels || []);
  const render = (box, service, models) => {
    box.textContent = "";
    for (const m of models) {
      const label = document.createElement("label");
      label.className = "check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.key = hiddenKey(service, m.id);
      input.checked = !hidden.has(input.dataset.key);
      label.append(input, ` ${m.name || modelName(m.id)} `);
      const code = document.createElement("code");
      code.textContent = m.id;
      label.append(code);
      box.appendChild(label);
    }
  };
  render(document.getElementById("models-anthropic"), "anthropic", anthropicModels(s));
  render(document.getElementById("models-claude"), "claude", CLAUDE_MODELS);
}

document.getElementById("refresh-models").addEventListener("click", () => {
  const out = document.getElementById("refresh-result");
  const values = readForm();
  if (!values.anthropicKey || !values.anthropicBaseUrl) {
    out.className = "test-result bad";
    out.textContent = "Fill in the address and the key first.";
    return;
  }
  const granted = browser.permissions.request({ origins: [originPattern(values.anthropicBaseUrl)] }).catch(() => false);
  out.className = "test-result";
  out.textContent = "Asking Anthropic…";
  (async () => {
    try {
      if (!(await granted)) {
        throw new Error("Thunderbird was not allowed to contact this address.");
      }
      const list = (await fetchAnthropicModels(values)).filter(m => /^claude-/.test(m.id));
      if (!list.length) {
        throw new Error("The list came back empty.");
      }
      current = await saveSettings({ anthropicModelList: list, hiddenModels: values.hiddenModels });
      fillModels(current);
      out.className = "test-result ok";
      out.textContent = `${list.length} models.`;
    } catch (e) {
      out.className = "test-result bad";
      out.textContent = String(e.message || e);
    }
  })();
});

getSettings().then(s => {
  current = s;
  fillModels(s);
  fillForm(s);
  updateCount();
});

document.documentElement.dataset.os = /win/i.test(navigator.platform) ? "win" : "unix";
