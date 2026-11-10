// Background: buttons, shortcuts, context menus and content-script setup.
// It never talks to an AI service; the panel and the compose popup do that,
// and only when the user asks.

import { availableProviders, getSettings } from "./lib/settings.js";

const panelUrl = tabId => `panel/panel.html?tabId=${tabId}`;

// Requests waiting for a panel or compose popup to open (menu clicks).
const pendingPanel = new Map();
let pendingCompose = null;

async function setPinned(pinned) {
  await messenger.storage.local.set({ panelPinned: pinned });
}

async function openPanelWindow(tabId) {
  await messenger.windows.create({
    url: panelUrl(tabId),
    type: "popup",
    width: 420,
    height: 720,
  });
}

async function showPanel(tabId) {
  try {
    await messenger.aiPanel.show(tabId, panelUrl(tabId));
    await setPinned(true);
  } catch (e) {
    console.warn("AI assistant: docking the panel failed, opening a window instead.", e);
    await openPanelWindow(tabId);
  }
}

async function hidePanel(tabId) {
  try {
    await messenger.aiPanel.hide(tabId);
  } catch (e) {}
  await setPinned(false);
}

async function togglePanel(tabId) {
  let open = false;
  try {
    open = await messenger.aiPanel.isOpen(tabId);
  } catch (e) {}
  if (open) {
    await hidePanel(tabId);
  } else {
    await showPanel(tabId);
  }
}

async function activeTabId() {
  const [tab] = await messenger.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

messenger.messageDisplayAction.onClicked.addListener(tab => togglePanel(tab.id));

messenger.commands.onCommand.addListener(async (command, tab) => {
  if (command != "toggle-panel") {
    return;
  }
  const tabId = tab?.id ?? (await activeTabId());
  if (tabId != null) {
    togglePanel(tabId);
  }
});

// Keep the panel open in new message tabs/windows when the user left it open.
async function restorePanel(tabId) {
  const { panelPinned } = await messenger.storage.local.get("panelPinned");
  if (!panelPinned) {
    return;
  }
  try {
    if (!(await messenger.aiPanel.isOpen(tabId))) {
      await messenger.aiPanel.show(tabId, panelUrl(tabId));
    }
  } catch (e) {}
}
messenger.messageDisplay.onMessagesDisplayed.addListener(tab => restorePanel(tab.id));
// Some builds never fire onMessagesDisplayed; selection changes still arrive.
messenger.mailTabs.onSelectedMessagesChanged.addListener((tab, list) => {
  if ((list?.messages || []).length == 1) {
    restorePanel(tab.id);
  }
});

messenger.runtime.onMessage.addListener((msg, sender) => {
  switch (msg?.type) {
    case "take-pending": {
      const p = pendingPanel.get(msg.tabId) || null;
      pendingPanel.delete(msg.tabId);
      return Promise.resolve(p);
    }
    case "take-compose-pending": {
      const p = pendingCompose && pendingCompose.tabId == msg.tabId ? pendingCompose : null;
      pendingCompose = null;
      return Promise.resolve(p);
    }
    case "hide-panel":
      return hidePanel(msg.tabId);
  }
  return undefined;
});

// ---------------------------------------------------------------- menus

const MESSAGE_ITEMS = ["ai-ask", "ai-explain", "ai-translate"];

function createMenus() {
  messenger.menus.removeAll().then(() => {
    messenger.menus.create({ id: "ai-message", title: "AI assistant", contexts: ["selection"] });
    messenger.menus.create({ id: "ai-ask", parentId: "ai-message", title: "Ask about this…", contexts: ["selection"] });
    messenger.menus.create({ id: "ai-explain", parentId: "ai-message", title: "Explain this", contexts: ["selection"] });
    messenger.menus.create({ id: "ai-translate", parentId: "ai-message", title: "Translate this", contexts: ["selection"] });

    messenger.menus.create({ id: "ai-compose", title: "AI writing help", contexts: ["compose_body"] });
    const sub = [
      ["ai-c-improve", "Improve writing"],
      ["ai-c-grammar", "Fix spelling"],
      ["ai-c-shorter", "Make shorter"],
      ["ai-c-formal", "More formal"],
      ["ai-c-friendly", "Friendlier"],
      ["ai-c-translate", "Translate…"],
      ["ai-c-open", "More…"],
    ];
    for (const [id, title] of sub) {
      messenger.menus.create({ id, parentId: "ai-compose", title, contexts: ["compose_body"] });
    }
  });
}

messenger.menus.onShown.addListener((info, tab) => {
  // In the composer, offer only the writing help.
  const inCompose = tab?.type == "messageCompose";
  messenger.menus.update("ai-message", { visible: !inCompose });
  messenger.menus.refresh();
});

messenger.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId.startsWith("ai-c-")) {
    const op = info.menuItemId.slice(5);
    pendingCompose = op == "open" ? null : { tabId: tab.id, op };
    // Must be called right away, while the click still counts as user input.
    messenger.composeAction.openPopup({ windowId: tab.windowId });
    return;
  }
  if (MESSAGE_ITEMS.includes(info.menuItemId)) {
    pendingPanel.set(tab.id, {
      mode: info.menuItemId.slice(3),
      text: info.selectionText || "",
    });
    (async () => {
      let open = false;
      try {
        open = await messenger.aiPanel.isOpen(tab.id);
      } catch (e) {}
      if (open) {
        messenger.runtime.sendMessage({ type: "panel-pending", tabId: tab.id }).catch(() => {});
      } else {
        await showPanel(tab.id);
      }
    })();
  }
});

// ---------------------------------------------------------------- scripts

async function registerScripts() {
  try {
    const md = await messenger.scripting.messageDisplay.getRegisteredScripts();
    if (!md.some(s => s.id == "ai-selection")) {
      await messenger.scripting.messageDisplay.registerScripts([
        { id: "ai-selection", js: ["scripts/message-selection.js"] },
      ]);
    }
  } catch (e) {
    console.error("AI assistant: message script", e);
  }
  try {
    const cs = await messenger.scripting.compose.getRegisteredScripts();
    if (!cs.some(s => s.id == "ai-compose")) {
      await messenger.scripting.compose.registerScripts([
        { id: "ai-compose", js: ["scripts/compose-editor.js"] },
      ]);
    }
  } catch (e) {
    console.error("AI assistant: compose script", e);
  }
}

messenger.runtime.onInstalled.addListener(async ({ reason }) => {
  createMenus();
  if (reason == "install") {
    const settings = await getSettings();
    if (!availableProviders(settings).length) {
      messenger.runtime.openOptionsPage();
    }
  }
});
messenger.runtime.onStartup.addListener(createMenus);

registerScripts();
