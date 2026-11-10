/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global ExtensionAPI */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionParent } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionParent.sys.mjs"
);
var { ExtensionUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionUtils.sys.mjs"
);
var { ExtensionError } = ExtensionUtils;

const BOX_ID = "ai-assistant-sidebar-box";
const SPLITTER_ID = "ai-assistant-sidebar-splitter";
const WIDTH_PREF = "extensions.ai-assistant.panelWidth";

// Every panel this extension inserted, so they can be removed on shutdown.
const inserted = new Set();

/**
 * Finds the about:message window that shows the message for a native tab.
 * mail3PaneTab: the 3-pane's message browser; mailMessageTab: the tab's own
 * about:message; a standalone message window: its messageBrowser.
 */
function getAboutMessage(nativeTab) {
  if (!nativeTab) {
    return null;
  }
  if (nativeTab.mode) {
    const win = nativeTab.chromeBrowser?.contentWindow;
    if (nativeTab.mode.name == "mail3PaneTab") {
      return win?.messageBrowser?.contentWindow ?? null;
    }
    if (nativeTab.mode.name == "mailMessageTab") {
      return win ?? null;
    }
    return null;
  }
  return nativeTab.messageBrowser?.contentWindow ?? null;
}

function promiseEvent(target, type) {
  return new Promise(resolve => {
    target.addEventListener(type, resolve, { once: true });
  });
}

function removePanel(entry) {
  inserted.delete(entry);
  try {
    const width = parseInt(entry.box.style.width, 10);
    if (width > 0) {
      Services.prefs.setIntPref(WIDTH_PREF, width);
    }
  } catch (e) {}
  entry.box.remove();
  entry.splitter.remove();
}

async function createPanel(extension, doc, url) {
  const wrapper = doc.getElementById("messagepaneboxwrapper");
  const paneBox = doc.getElementById("messagepanebox");
  if (!wrapper || !paneBox) {
    throw new ExtensionError("The message reader is not ready yet.");
  }

  const splitter = doc.createXULElement("splitter");
  splitter.id = SPLITTER_ID;
  splitter.setAttribute("resizebefore", "closest");
  splitter.setAttribute("resizeafter", "closest");
  splitter.setAttribute("orient", "horizontal");
  splitter.style.minWidth = "4px";
  splitter.style.borderInlineStart = "1px solid var(--splitter-color, rgba(128,128,128,.35))";

  const box = doc.createXULElement("vbox");
  box.id = BOX_ID;
  const width = Services.prefs.getIntPref(WIDTH_PREF, 380);
  box.style.width = `${Math.max(280, Math.min(900, width))}px`;
  box.style.minWidth = "260px";
  box.style.overflow = "hidden";

  const browser = doc.createXULElement("browser");
  browser.setAttribute("type", "content");
  browser.setAttribute("disableglobalhistory", "true");
  browser.setAttribute("messagemanagergroup", "webext-browsers");
  browser.setAttribute("webextension-view-type", "sidebar");
  browser.setAttribute("flex", "1");
  browser.setAttribute("tooltip", "aHTMLTooltip");
  browser.setAttribute("autocompletepopup", "PopupAutoComplete");
  browser.setAttribute(
    "initialBrowsingContextGroupId",
    extension.policy.browsingContextGroupId
  );
  if (extension.remote) {
    browser.setAttribute("remote", "true");
    browser.setAttribute("remoteType", extension.remoteType);
    browser.setAttribute("maychangeremoteness", "true");
  }

  const ready = extension.remote
    ? promiseEvent(browser, "XULFrameLoaderCreated")
    : promiseEvent(browser, "load");

  box.appendChild(browser);
  wrapper.insertBefore(splitter, paneBox.nextSibling);
  wrapper.insertBefore(box, splitter.nextSibling);

  const entry = { box, splitter, browser };
  inserted.add(entry);

  if (!extension.remote) {
    // eslint-disable-next-line no-unused-expressions
    browser.contentWindow;
  }

  const announce = () => {
    ExtensionParent.apiManager.emit("extension-browser-inserted", browser);
  };
  browser.addEventListener("DidChangeBrowserRemoteness", announce);

  await ready;
  announce();
  browser.fixupAndLoadURIString(url, {
    triggeringPrincipal: extension.principal,
  });

  doc.defaultView.addEventListener("unload", () => inserted.delete(entry), {
    once: true,
  });
  return entry;
}

this.aiPanel = class extends ExtensionCommon.ExtensionAPI {
  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }
    for (const entry of [...inserted]) {
      try {
        removePanel(entry);
      } catch (e) {
        console.error(e);
      }
    }
  }

  getAPI(context) {
    const { extension } = context;

    function docForTab(tabId) {
      const tab = extension.tabManager.get(tabId);
      const aboutMessage = getAboutMessage(tab.nativeTab);
      if (!aboutMessage?.document) {
        throw new ExtensionError("This tab has no message reader.");
      }
      return aboutMessage.document;
    }

    function resolve(path) {
      const base = extension.baseURI.spec;
      const url = extension.baseURI.resolve(path);
      if (!url.startsWith(base)) {
        throw new ExtensionError("Only pages of this extension can be shown.");
      }
      return url;
    }

    return {
      aiPanel: {
        async show(tabId, path) {
          const doc = docForTab(tabId);
          const url = resolve(path);
          const box = doc.getElementById(BOX_ID);
          if (box) {
            box.hidden = false;
            doc.getElementById(SPLITTER_ID).hidden = false;
            return true;
          }
          if (doc.readyState != "complete") {
            await promiseEvent(doc.defaultView, "load");
          }
          await createPanel(extension, doc, url);
          return true;
        },
        async hide(tabId) {
          const doc = docForTab(tabId);
          const box = doc.getElementById(BOX_ID);
          if (box) {
            const width = parseInt(box.style.width, 10);
            if (width > 0) {
              Services.prefs.setIntPref(WIDTH_PREF, width);
            }
            box.hidden = true;
            doc.getElementById(SPLITTER_ID).hidden = true;
          }
          return false;
        },
        // The message shown in the tab's reader. Unlike
        // messageDisplay.getDisplayedMessages() this doesn't wait for the
        // reader's "loaded" flag, which some builds never set.
        async getDisplayedMessage(tabId) {
          let doc;
          try {
            doc = docForTab(tabId);
          } catch (e) {
            return null;
          }
          const win = doc.defaultView;
          const browser = win.browsingContext?.embedderElement;
          if (browser?.hidden) {
            return null;
          }
          const hdr = win.gMessage;
          if (!hdr) {
            return null;
          }
          return extension.messageManager.convert(hdr) ?? null;
        },
        async isOpen(tabId) {
          let doc;
          try {
            doc = docForTab(tabId);
          } catch (e) {
            return false;
          }
          const box = doc.getElementById(BOX_ID);
          return !!box && !box.hidden;
        },
      },
    };
  }
};
