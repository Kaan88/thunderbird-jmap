import {
  availableProviders,
  getSettings,
  hasHostAccess,
  originPattern,
  pickProvider,
  requestHostAccess,
  saveSettings,
  savedPrompts,
} from "../lib/settings.js";
import { EFFORTS, supportsEffort } from "../lib/models.js";
import { runAgent } from "../lib/providers.js";
import { toolsFor, runTool, isAction, openReply, openNewMessage } from "../lib/tools.js";
import { describeHeader, messageForModel } from "../lib/mail.js";
import { systemPrompt, nowLine, QUICK_ACTIONS, GLOBAL_ACTIONS } from "../lib/prompts.js";
import { renderMarkdown } from "../lib/markdown.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);

const state = {
  tabId: params.has("tabId") ? Number(params.get("tabId")) : null,
  settings: null,
  message: null, // header of the open message
  selection: "",
  history: [],
  system: null,
  tools: null,
  convSettings: null,
  sentContext: new Set(),
  lastMessageId: null,
  busy: false,
  abort: null,
  pendingApprovals: new Set(),
};

// ---------------------------------------------------------------- setup

async function init() {
  state.settings = await getSettings();
  if (state.tabId == null) {
    state.tabId = await guessTab();
  }
  fillProviders();
  wireUi();
  renderEmpty();
  await refreshMessage();

  messenger.messageDisplay.onMessagesDisplayed.addListener((tab, list) => {
    if (tab.id == state.tabId) {
      refreshMessage(list);
    }
  });
  // Backup triggers for builds where onMessagesDisplayed never fires.
  messenger.mailTabs.onSelectedMessagesChanged.addListener(tab => {
    if (tab.id == state.tabId) {
      refreshSoon();
    }
  });
  messenger.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type == "ai-message-shown" && sender.tab?.id == state.tabId) {
      if (!state.message) {
        refreshSoon();
      }
    } else if (msg?.type == "ai-selection" && sender.tab?.id == state.tabId) {
      setSelection(msg.text);
    } else if (msg?.type == "panel-pending" && msg.tabId == state.tabId) {
      takePending();
    }
  });
  messenger.storage.onChanged.addListener(async (changes, area) => {
    if (area == "local" && changes.settings) {
      const before = changes.settings.oldValue || {};
      state.settings = await getSettings();
      const s = state.settings;
      // A new default service (or model) in the settings wins over the
      // panel's current pick.
      fillProviders(
        before.defaultProvider != s.defaultProvider || before.claudeModel != s.claudeModel
          ? pickProvider(s, null)?.id
          : undefined
      );
      renderEmpty();
    }
  });
  takePending();
}

async function guessTab() {
  const tabs = await messenger.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs.find(t => t.type == "mail" || t.type == "messageDisplay");
  if (tab) {
    return tab.id;
  }
  const all = await messenger.tabs.query({ active: true, type: ["mail", "messageDisplay"] });
  return all[0]?.id ?? null;
}

function fillProviders(prefer) {
  const sel = $("provider");
  const current = prefer || sel.value;
  sel.textContent = "";
  const list = availableProviders(state.settings);
  for (const p of list) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.title || `${p.id == "anthropic" ? "Anthropic" : "OpenAI-compat."} · ${p.model}`;
    sel.appendChild(o);
  }
  const pick = pickProvider(state.settings, current);
  if (pick) {
    sel.value = pick.id;
  }
  sel.classList.toggle("hidden", list.length < 2);
  $("setup").classList.toggle("hidden", list.length > 0);
  fillEffort();
}

// Effort menu: only for Claude models that take an effort level.
function fillEffort() {
  const sel = $("effort");
  if (!sel.options.length) {
    for (const e of EFFORTS) {
      const o = document.createElement("option");
      o.value = e.id;
      o.textContent = e.id ? e.name.replace(" effort", "") : "Auto";
      o.title = e.name;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => saveSettings({ effort: sel.value }));
  }
  sel.value = state.settings.effort || "";
  const p = currentProvider();
  const kind = p?.kind || p?.id;
  sel.classList.toggle("hidden", !p || !((kind == "anthropic" || kind == "claude") && supportsEffort(p.model)));
}

// The docked panel asks its own bridge first: messageDisplay.getDisplayedMessages()
// waits for the reader's "loaded" flag, which some builds never set.
async function displayedMessages(tabId) {
  try {
    const one = await messenger.aiPanel.getDisplayedMessage(tabId);
    return one ? [one] : [];
  } catch (e) {
    // No experiment (or not a reader tab): fall back to the regular API.
  }
  try {
    const page = await Promise.race([
      messenger.messageDisplay.getDisplayedMessages(tabId),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 3000)),
    ]);
    return page.messages || page || [];
  } catch (e) {
    console.warn("AI assistant: could not read the open message", e);
    return [];
  }
}

let refreshTimer = 0;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refreshMessage();
    if (!state.message) {
      // The reader may not have picked up the message yet.
      refreshTimer = setTimeout(() => refreshMessage(), 800);
    }
  }, 150);
}

async function refreshMessage(list) {
  let messages = list?.messages;
  if (!messages && state.tabId != null) {
    messages = await displayedMessages(state.tabId);
  }
  messages ||= [];
  state.message = messages.length == 1 ? messages[0] : null;
  if (state.message) {
    state.lastMessageId = state.message.id;
  }
  setSelection("");
  const ctx = $("context");
  ctx.textContent = state.message ? `Now about: ${state.message.subject || "(no subject)"}` : "";
  ctx.title = ctx.textContent;
  $("input").placeholder = state.message ? "Ask about this message…" : "Ask anything or search your mail…";
  renderEmpty();
}

function renderEmpty() {
  const empty = $("empty");
  if (!empty) {
    return;
  }
  $("empty-text").textContent = state.message
    ? "Pick an action from the Actions menu, or ask about this message. Highlight a passage to ask about that part."
    : "Open a message to work on it, or ask anything: the assistant can look in your mail, calendar and contacts.";
  const quick = $("quick");
  quick.textContent = "";
  const items = state.message ? QUICK_ACTIONS.slice(0, 4) : GLOBAL_ACTIONS.slice(0, 3);
  for (const a of items) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = a.label;
    b.addEventListener("click", () => runQuick(a));
    quick.appendChild(b);
  }
}

function setSelection(text) {
  state.selection = String(text || "").trim();
  $("selection").classList.toggle("hidden", !state.selection);
  $("selection-text").textContent = state.selection ? `“${state.selection.replace(/\s+/g, " ")}”` : "";
  $("selection-text").title = state.selection;
  $("input").placeholder = state.selection
    ? "Ask about the highlighted passage…"
    : state.message
      ? "Ask about this message…"
      : "Ask anything or search your mail…";
}

async function takePending() {
  let pending;
  try {
    pending = await messenger.runtime.sendMessage({ type: "take-pending", tabId: state.tabId });
  } catch (e) {
    return;
  }
  if (!pending) {
    return;
  }
  setSelection(pending.text);
  const prompts = {
    ask: null,
    explain: "Explain the highlighted passage in plain words.",
    translate: `Translate the highlighted passage into ${state.settings.translateTo || "English"}.`,
  };
  const prompt = prompts[pending.mode];
  if (prompt) {
    send(prompt);
  } else {
    $("input").focus();
  }
}

// ---------------------------------------------------------------- UI wiring

function wireUi() {
  const input = $("input");
  input.addEventListener("keydown", e => {
    if (e.key == "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener("input", autosize);
  $("send").addEventListener("click", submit);
  $("stop").addEventListener("click", () => state.abort?.abort());
  $("new-chat").addEventListener("click", newChat);
  $("settings").addEventListener("click", () => messenger.runtime.openOptionsPage());
  $("open-settings").addEventListener("click", () => messenger.runtime.openOptionsPage());
  $("close").addEventListener("click", async () => {
    try {
      await messenger.runtime.sendMessage({ type: "hide-panel", tabId: state.tabId });
    } catch (e) {}
    if (!params.has("tabId")) {
      window.close();
    }
  });
  $("provider").addEventListener("change", fillEffort);
  $("selection-clear").addEventListener("click", () => setSelection(""));
  $("grant").addEventListener("click", () => {
    const provider = currentProvider();
    // permissions.request must run inside the click, before any await.
    requestHostAccess(provider.baseUrl).then(ok => {
      if (ok) {
        $("access").classList.add("hidden");
        if (state.retryText) {
          const text = state.retryText;
          state.retryText = null;
          send(text);
        }
      }
    });
  });
  $("actions").addEventListener("click", toggleMenu);
  document.addEventListener("click", e => {
    if (!e.target.closest(".menu-wrap")) {
      closeMenu();
    }
  });
  document.addEventListener("keydown", e => {
    if (e.key == "Escape") {
      closeMenu();
    }
  });
}

function autosize() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(160, t.scrollHeight) + "px";
}

function toggleMenu() {
  const menu = $("menu");
  if (!menu.classList.contains("hidden")) {
    closeMenu();
    return;
  }
  menu.textContent = "";
  const group = label => {
    const g = document.createElement("div");
    g.className = "group";
    g.textContent = label;
    menu.appendChild(g);
  };
  const item = a => {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.textContent = a.label;
    b.addEventListener("click", () => {
      closeMenu();
      runQuick(a);
    });
    menu.appendChild(b);
  };
  if (state.message) {
    group("This message");
    QUICK_ACTIONS.forEach(item);
    item({
      label: `Translate to ${state.settings.translateTo || "English"}`,
      prompt: `Translate this message into ${state.settings.translateTo || "English"}.`,
    });
  }
  if (state.settings.lookups !== false) {
    group("Look up");
    GLOBAL_ACTIONS.forEach(item);
  }
  const saved = savedPrompts(state.settings);
  if (saved.length) {
    group("Your prompts");
    saved.forEach(p => item({ label: p.name, prompt: p.prompt }));
  }
  menu.classList.remove("hidden");
  $("actions").setAttribute("aria-expanded", "true");
  menu.querySelector("button")?.focus();
}

function closeMenu() {
  $("menu").classList.add("hidden");
  $("actions").setAttribute("aria-expanded", "false");
}

function runQuick(a) {
  if (a.fill) {
    const input = $("input");
    input.value = a.fill;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return;
  }
  send(a.prompt, { label: a.label });
}

function submit() {
  const text = $("input").value.trim();
  if (!text || state.busy) {
    return;
  }
  $("input").value = "";
  autosize();
  send(text);
}

function newChat() {
  state.abort?.abort();
  state.history = [];
  state.system = null;
  state.tools = null;
  state.convSettings = null;
  state.sentContext.clear();
  const log = $("log");
  for (const el of [...log.children]) {
    if (el.id != "empty") {
      el.remove();
    }
  }
  $("empty").classList.remove("hidden");
  renderEmpty();
  $("input").focus();
}

function currentProvider() {
  return pickProvider(state.settings, $("provider").value);
}

function scrollDown() {
  const log = $("log");
  if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) {
    log.scrollTop = log.scrollHeight;
  }
}

function setBusy(busy) {
  state.busy = busy;
  $("send").classList.toggle("hidden", busy);
  $("stop").classList.toggle("hidden", !busy);
}

// ---------------------------------------------------------------- chat

async function identityLine() {
  try {
    const folder = state.message?.folder;
    const accounts = await messenger.accounts.list(true);
    const account = (folder && accounts.find(a => a.id == folder.accountId)) || accounts[0];
    const id = account?.identities?.[0];
    if (id) {
      return id.name ? `${id.name} <${id.email}>` : id.email;
    }
  } catch (e) {}
  return "";
}

async function buildUserTurn(text) {
  const parts = [nowLine()];
  const msg = state.message;
  if (msg) {
    if (!state.sentContext.has(msg.id)) {
      const { text: email } = await messageForModel(msg.id);
      parts.push(`The user has this message open:\n${email}`);
      state.sentContext.add(msg.id);
    } else {
      parts.push(`The open message is still <email id="${msg.id}"> “${msg.subject}”.`);
    }
  } else if (state.sentContext.size) {
    parts.push("No message is open now.");
  }
  if (state.selection) {
    parts.push(
      `The user highlighted this passage in the open message:\n<passage>\n${state.selection.slice(0, 4000)}\n</passage>`
    );
  }
  parts.push(`The user asks:\n${text}`);
  return parts.join("\n\n");
}

function addUserBubble(text, label) {
  const div = document.createElement("div");
  div.className = "msg-user";
  if (state.selection) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `About: “${state.selection.replace(/\s+/g, " ").slice(0, 80)}”`;
    div.appendChild(tag);
  }
  div.appendChild(document.createTextNode(label || text));
  $("log").appendChild(div);
}

class AnswerView {
  constructor() {
    this.el = document.createElement("div");
    this.el.className = "msg-ai";
    $("log").appendChild(this.el);
    this.seg = null;
    this.buffer = "";
    this.all = "";
    this.raf = 0;
    this.newSegment();
  }
  newSegment() {
    if (this.seg && !this.buffer) {
      this.seg.remove();
    }
    this.seg = document.createElement("div");
    this.seg.className = "seg md typing";
    this.el.appendChild(this.seg);
    this.buffer = "";
  }
  text(chunk) {
    this.buffer += chunk;
    this.all += chunk;
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.render();
      });
    }
  }
  render() {
    renderMarkdown(this.seg, this.buffer, { onLink, onFence });
    if (this.buffer) {
      this.seg.classList.add("has-text");
    }
    scrollDown();
  }
  append(node) {
    if (!this.buffer) {
      this.seg.remove();
    } else {
      this.seg.classList.remove("typing");
    }
    this.el.appendChild(node);
    this.newSegment();
    scrollDown();
  }
  finish() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.buffer) {
      this.render();
    }
    this.seg.classList.remove("typing");
    if (!this.buffer) {
      this.seg.remove();
    }
    if (this.all.trim()) {
      const tools = document.createElement("div");
      tools.className = "tools";
      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(this.all.trim());
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      });
      tools.appendChild(copy);
      this.el.appendChild(tools);
    }
  }
  error(message) {
    const div = document.createElement("div");
    div.className = "error";
    div.textContent = message;
    this.append(div);
  }
}

function onLink(href) {
  if (/^https?:\/\//i.test(href)) {
    messenger.windows.openDefaultBrowser(href);
  }
}

function onFence(lang, code) {
  if (lang != "email") {
    return null;
  }
  const box = document.createElement("div");
  box.className = "email-draft";
  const text = document.createElement("div");
  text.className = "text";
  text.textContent = code;
  box.appendChild(text);
  const buttons = document.createElement("div");
  buttons.className = "buttons";
  const add = (label, fn, primary) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (primary) {
      b.className = "primary";
    }
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        b.textContent = `Failed: ${e.message}`;
        return;
      }
      b.disabled = false;
    });
    buttons.appendChild(b);
  };
  const replyTo = state.lastMessageId;
  if (replyTo) {
    add("Open as reply", () => openReply(replyTo, code, false), true);
    add("Reply all", () => openReply(replyTo, code, true));
  }
  add("New message", () => openNewMessage({}, code), !replyTo);
  add("Copy", () => navigator.clipboard.writeText(code));
  box.appendChild(buttons);
  return box;
}

const STEP_LABELS = {
  search_mail: "Searched your mail",
  read_message: "Read a message",
  list_folders: "Looked at your folders",
  search_contacts: "Searched your contacts",
  list_events: "Checked your calendar",
  list_tasks: "Checked your tasks",
  list_calendars: "Looked at your calendars",
  list_messages: "Listed a folder",
  read_attachment: "Read an attachment",
  list_accounts: "Looked at your accounts",
  list_tags: "Looked at your tags",
  list_address_books: "Looked at your address books",
  get_contact: "Read a contact",
  list_mailing_lists: "Looked at your mailing lists",
  open_message: "Opened a message",
  show_folder: "Showed a folder",
  open_address_book: "Opened the address book",
  jmap_accounts: "Looked at your JMAP accounts",
  jmap_request: "Asked the JMAP server",
  jmap_download: "Downloaded from the JMAP server",
};

function stepView(call, result) {
  const d = document.createElement("details");
  d.className = "step" + (result.isError ? " failed" : "");
  const s = document.createElement("summary");
  let label = STEP_LABELS[call.name] || call.name;
  if (call.name == "search_mail") {
    const n = result.found?.length ?? 0;
    label += ` · ${n} found`;
  }
  if (result.isError) {
    label += " · failed";
  }
  s.textContent = label;
  d.appendChild(s);
  if (result.found?.length) {
    const ul = document.createElement("ul");
    ul.className = "found";
    for (const m of result.found.slice(0, 20)) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = `${m.subject || "(no subject)"}`;
      a.title = `${m.author} · ${new Date(m.date).toLocaleString()}`;
      a.addEventListener("click", () =>
        messenger.messageDisplay.open({ messageId: m.id, location: "tab" })
      );
      li.appendChild(a);
      li.appendChild(document.createTextNode(` — ${String(m.author || "").replace(/<.*>/, "").trim()}`));
      ul.appendChild(li);
    }
    d.appendChild(ul);
  } else {
    const pre = document.createElement("div");
    pre.className = "muted";
    const args = Object.entries(call.args || {})
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join(" · ");
    pre.textContent = args || "";
    if (result.isError) {
      pre.textContent += (args ? " — " : "") + result.content;
    }
    d.appendChild(pre);
  }
  return d;
}

function approvalView(view, description, { always, details, confirmLabel, danger }) {
  const card = document.createElement("div");
  card.className = "approval";
  if (danger) {
    card.classList.add("danger");
  }
  const what = document.createElement("div");
  what.className = "what";
  what.textContent = description;
  card.appendChild(what);
  if (details) {
    const pre = document.createElement("pre");
    pre.className = "details";
    pre.textContent = details;
    card.appendChild(pre);
  }
  if (!always) {
    card.classList.add("done");
    what.textContent = `Did: ${description}`;
    view.append(card);
    return Promise.resolve(true);
  }
  const buttons = document.createElement("div");
  buttons.className = "buttons";
  const yes = document.createElement("button");
  yes.className = "primary";
  yes.textContent = confirmLabel || "Do it";
  const no = document.createElement("button");
  no.textContent = "Skip";
  buttons.append(yes, no);
  card.appendChild(buttons);
  view.append(card);
  yes.focus();
  return new Promise(resolve => {
    const done = ok => {
      state.pendingApprovals.delete(entry);
      card.classList.add("done");
      buttons.remove();
      const status = document.createElement("div");
      status.className = "status";
      status.textContent = ok ? "Approved" : "Skipped";
      card.appendChild(status);
      resolve(ok);
    };
    const entry = { cancel: () => done(false) };
    state.pendingApprovals.add(entry);
    yes.addEventListener("click", () => done(true));
    no.addEventListener("click", () => done(false));
  });
}

function friendlyError(e, provider) {
  const msg = String(e?.message || e);
  if (e?.name == "AbortError") {
    return "Stopped.";
  }
  if (e?.status == 401 || e?.status == 403) {
    return `The ${provider.label} service refused the key (${msg}). Check the API key in the settings.`;
  }
  if (e?.status == 404) {
    return `Not found (${msg}). Check the address and the model name (${provider.model}) in the settings.`;
  }
  if (e?.status == 429) {
    return `The service is busy or your quota is used up (${msg}). Try again in a moment.`;
  }
  if (/NetworkError|Failed to fetch/i.test(msg) && provider.baseUrl) {
    return `Can't reach ${provider.baseUrl}. Check the address and your connection.`;
  }
  return msg;
}

async function send(text, { label } = {}) {
  if (state.busy) {
    return;
  }
  const provider = currentProvider();
  if (!provider) {
    $("setup").classList.remove("hidden");
    $("empty").classList.remove("hidden");
    return;
  }
  if (!(await hasHostAccess(provider.baseUrl))) {
    $("access-host").textContent = originPattern(provider.baseUrl).replace(/\/\*$/, "");
    $("access").classList.remove("hidden");
    state.retryText = text;
    return;
  }
  $("access").classList.add("hidden");
  $("empty").classList.add("hidden");

  if (!state.system) {
    // Frozen for the whole conversation (see lib/prompts.js).
    state.convSettings = { ...state.settings };
    state.system = systemPrompt(state.convSettings, await identityLine());
    state.tools = toolsFor(state.convSettings);
  }

  setBusy(true);
  addUserBubble(text, label);
  const view = new AnswerView();
  scrollDown();
  const abort = new AbortController();
  state.abort = abort;
  abort.signal.addEventListener("abort", () => {
    for (const p of [...state.pendingApprovals]) {
      p.cancel();
    }
  });

  try {
    state.history.push({ role: "user", text: await buildUserTurn(text) });
    setSelection("");
    await runAgent({
      settings: state.settings,
      provider,
      system: state.system,
      history: state.history,
      tools: state.tools,
      signal: abort.signal,
      onText: chunk => view.text(chunk),
      onTurnStart: step => {
        if (step > 0) {
          view.newSegment();
        }
      },
      runTool: async call => {
        if (call.name == "read_message" || call.name == "search_mail") {
          state.lastMessageId = call.name == "read_message" ? Number(call.args.id) : state.lastMessageId;
        }
        if (call.args?.replyTo) {
          state.lastMessageId = Number(call.args.replyTo);
        }
        let result;
        try {
          result = await runTool(call, {
            settings: state.convSettings,
            approve: (description, opts) => approvalView(view, description, opts),
            signal: abort.signal,
          });
        } catch (e) {
          if (e?.name != "AbortError") {
            view.error(`${call.name} failed: ${e?.message || e}`);
          }
          throw e;
        }
        if (!isAction(call.name, call.args)) {
          view.append(stepView(call, result));
        } else if (result.isError) {
          view.error(result.content);
        }
        const { found, ...rest } = result;
        return rest;
      },
    });
  } catch (e) {
    console.error("AI assistant:", e);
    view.error(friendlyError(e, provider));
  } finally {
    view.finish();
    setBusy(false);
    state.abort = null;
    scrollDown();
  }
}

init().catch(e => {
  console.error(e);
  document.body.textContent = `The assistant could not start: ${e.message}`;
});
