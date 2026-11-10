import {
  availableProviders,
  getSettings,
  hasHostAccess,
  originPattern,
  pickProvider,
  requestHostAccess,
} from "../lib/settings.js";
import { complete } from "../lib/providers.js";
import { COMPOSE_SYSTEM, REWRITES } from "../lib/prompts.js";

const $ = id => document.getElementById(id);
const state = {
  tab: null,
  details: null,
  doc: { selection: "", own: "", quote: "" },
  settings: null,
  lastRun: null,
  result: "",
  abort: null,
  target: "own",
};

async function editorState(tabId) {
  try {
    return await messenger.tabs.sendMessage(tabId, { type: "ai-compose-state" });
  } catch (e) {
    // Compose windows opened before the add-on started have no script yet.
    await messenger.scripting.executeScript({
      target: { tabId },
      files: ["scripts/compose-editor.js"],
    });
    return messenger.tabs.sendMessage(tabId, { type: "ai-compose-state" });
  }
}

async function init() {
  state.settings = await getSettings();
  const [tab] = await messenger.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  state.details = await messenger.compose.getComposeDetails(tab.id);
  state.doc = (await editorState(tab.id)) || state.doc;

  fillProviders();
  $("lang").value = state.settings.translateTo || "English";
  describeTarget();
  wire();

  let pending = null;
  try {
    pending = await messenger.runtime.sendMessage({ type: "take-compose-pending", tabId: tab.id });
  } catch (e) {}
  if (pending?.op == "translate") {
    run({ op: "translate", lang: $("lang").value });
  } else if (pending?.op && REWRITES[pending.op]) {
    run({ op: "rewrite", how: REWRITES[pending.op] });
  } else {
    $("ask").focus();
  }
}

function fillProviders() {
  const sel = $("provider");
  sel.textContent = "";
  const list = availableProviders(state.settings);
  for (const p of list) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.title || `${p.id == "anthropic" ? "Anthropic" : "OpenAI-compat."} · ${p.model}`;
    sel.appendChild(o);
  }
  const pick = pickProvider(state.settings);
  if (pick) {
    sel.value = pick.id;
  }
  sel.classList.toggle("hidden", list.length < 2);
  $("setup").classList.toggle("hidden", list.length > 0);
}

function words(s) {
  return (String(s).match(/\S+/g) || []).length;
}

function describeTarget() {
  const { selection, own } = state.doc;
  state.target = selection ? "selection" : "own";
  $("target").textContent = selection
    ? `Working on the selected text (${words(selection)} words).`
    : own
      ? `Working on your draft (${words(own)} words). Select text to work on a part.`
      : "The draft is empty. Write a draft, or select text to rewrite.";
  $("apply").textContent = selection ? "Replace selection" : own ? "Replace draft" : "Insert";
}

function wire() {
  $("open-settings").addEventListener("click", () => messenger.runtime.openOptionsPage());
  $("write").addEventListener("click", () => {
    const ask = $("ask").value.trim();
    if (!ask && !state.doc.own && !state.doc.quote) {
      $("ask").focus();
      return;
    }
    run({ op: "write", ask });
  });
  $("ask").addEventListener("keydown", e => {
    if (e.key == "Enter" && (e.ctrlKey || e.metaKey)) {
      $("write").click();
    }
  });
  document.querySelectorAll("[data-rewrite]").forEach(b =>
    b.addEventListener("click", () => run({ op: "rewrite", how: REWRITES[b.dataset.rewrite] }))
  );
  $("tone-go").addEventListener("click", () => run({ op: "rewrite", how: REWRITES[$("tone").value] }));
  $("custom-go").addEventListener("click", () => {
    const how = $("custom").value.trim();
    if (how) {
      run({ op: "rewrite", how });
    }
  });
  $("custom").addEventListener("keydown", e => {
    if (e.key == "Enter") {
      $("custom-go").click();
    }
  });
  $("translate").addEventListener("click", () => {
    const lang = $("lang").value.trim();
    if (lang) {
      run({ op: "translate", lang });
    }
  });
  $("stop").addEventListener("click", () => state.abort?.abort());
  $("back").addEventListener("click", () => {
    state.abort?.abort();
    $("result").classList.add("hidden");
    $("tools").classList.remove("hidden");
  });
  $("again").addEventListener("click", () => state.lastRun && run(state.lastRun));
  $("copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.result);
    $("copy").textContent = "Copied";
  });
  $("apply").addEventListener("click", apply);
  $("grant").addEventListener("click", () => {
    const provider = pickProvider(state.settings, $("provider").value);
    requestHostAccess(provider.baseUrl).then(ok => {
      if (ok) {
        $("access").classList.add("hidden");
        if (state.lastRun) {
          run(state.lastRun);
        }
      }
    });
  });
}

function buildPrompt(job) {
  const { selection, own, quote } = state.doc;
  const d = state.details;
  const text = selection || own;
  const standing = String(state.settings.instructions || "").trim();
  const extra = standing ? `\n\nStanding instructions from the user:\n${standing}` : "";
  if (job.op == "write") {
    const lines = ["Write the body of this email."];
    if (d.from) lines.push(`From: ${d.from}`);
    if (d.to?.length) lines.push(`To: ${[].concat(d.to).join(", ")}`);
    if (d.subject) lines.push(`Subject: ${d.subject}`);
    if (quote) lines.push(`It answers this email:\n<email>\n${quote}\n</email>`);
    if (selection) lines.push(`Rewrite or continue this selected part:\n<text>\n${selection}\n</text>`);
    else if (own) lines.push(`What is written so far:\n<text>\n${own}\n</text>`);
    lines.push(job.ask ? `What it should say: ${job.ask}` : "Write a fitting reply.");
    lines.push("Include a greeting and a sign-off only if the draft has none and it fits; never invent facts, dates or promises.");
    return lines.join("\n") + extra;
  }
  if (!text) {
    return null;
  }
  if (job.op == "translate") {
    return `Translate this text into ${job.lang}. Keep the meaning, tone, line breaks and names.\n<text>\n${text}\n</text>${extra}`;
  }
  return `${job.how}\n<text>\n${text}\n</text>${extra}`;
}

async function run(job) {
  state.lastRun = job;
  const provider = pickProvider(state.settings, $("provider").value);
  if (!provider) {
    $("setup").classList.remove("hidden");
    return;
  }
  if (!(await hasHostAccess(provider.baseUrl))) {
    $("access-host").textContent = originPattern(provider.baseUrl).replace(/\/\*$/, "");
    $("access").classList.remove("hidden");
    return;
  }
  const prompt = buildPrompt(job);
  $("tools").classList.add("hidden");
  $("result").classList.remove("hidden");
  $("result-error").classList.add("hidden");
  const out = $("result-text");
  out.textContent = "";
  out.classList.add("typing");
  for (const id of ["apply", "copy", "again"]) {
    $(id).disabled = true;
  }
  $("copy").textContent = "Copy";
  $("result-title").textContent =
    job.op == "write" ? "Suggested text" : job.op == "translate" ? `Translation (${job.lang})` : "Rewritten text";
  if (!prompt) {
    out.classList.remove("typing");
    showError("Write something first, or select the text to work on.");
    return;
  }

  state.abort?.abort();
  const abort = new AbortController();
  state.abort = abort;
  $("stop").classList.remove("hidden");
  state.result = "";
  try {
    const text = await complete({
      settings: state.settings,
      provider,
      system: COMPOSE_SYSTEM,
      prompt,
      signal: abort.signal,
      onText: chunk => {
        state.result += chunk;
        out.textContent = state.result;
        out.scrollTop = out.scrollHeight;
      },
    });
    state.result = cleanResult(text || state.result);
    out.textContent = state.result;
    $("apply").disabled = !state.result;
    $("copy").disabled = !state.result;
  } catch (e) {
    if (e.name != "AbortError") {
      showError(String(e.message || e));
    }
  } finally {
    out.classList.remove("typing");
    $("again").disabled = false;
    $("stop").classList.add("hidden");
    if (state.abort == abort) {
      state.abort = null;
    }
  }
}

function cleanResult(text) {
  let t = String(text || "").trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) {
    t = fence[1].trim();
  }
  t = t.replace(/^<text>\s*|\s*<\/text>$/g, "");
  return t;
}

function showError(message) {
  const e = $("result-error");
  e.textContent = message;
  e.classList.remove("hidden");
}

async function apply() {
  const ok = await messenger.tabs.sendMessage(state.tab.id, {
    type: "ai-compose-replace",
    text: state.result,
    target: state.target,
    plain: !!state.details.isPlainText,
  });
  if (ok === false) {
    showError("Could not change the draft. Copy the text instead.");
    return;
  }
  window.close();
}

init().catch(e => {
  console.error(e);
  document.body.textContent = `The writing help could not start: ${e.message}`;
});
