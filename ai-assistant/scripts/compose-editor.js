// Runs in the compose editor. Lets the writing helper read the selection or
// the user's own text (everything above the quote/signature) and replace it.
// Changes go through execCommand so Ctrl+Z undoes them.
(() => {
  if (window.__aiAssistantCompose) {
    return;
  }
  window.__aiAssistantCompose = true;
  const BOUNDARY =
    'blockquote[type="cite"], .moz-cite-prefix, .moz-signature, .moz-forward-container, [_moz_quote], .moz-email-headers-table';
  const BLOCKS = new Set(["P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "TR"]);
  let savedRange = null;

  function boundary() {
    for (const n of document.body?.childNodes || []) {
      if (n.nodeType == 1 && (n.matches(BOUNDARY) || n.querySelector(":scope > .moz-cite-prefix"))) {
        return n;
      }
    }
    return null;
  }

  function ownRange() {
    const r = document.createRange();
    r.setStart(document.body, 0);
    const b = boundary();
    if (b) {
      r.setEndBefore(b);
    } else {
      r.setEnd(document.body, document.body.childNodes.length);
    }
    return r;
  }

  function toText(node) {
    let out = "";
    const walk = n => {
      if (n.nodeType == 3) {
        out += n.nodeValue;
        return;
      }
      if (n.nodeType != 1 && n.nodeType != 11) {
        return;
      }
      if (n.nodeName == "BR") {
        out += "\n";
        return;
      }
      const block = BLOCKS.has(n.nodeName);
      if (block && out && !out.endsWith("\n")) {
        out += "\n";
      }
      for (const c of n.childNodes) {
        walk(c);
      }
      if (block && n.nodeName == "P") {
        out += "\n";
      } else if (block && !out.endsWith("\n")) {
        out += "\n";
      }
    };
    walk(node);
    return out.replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function selectionRange() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) {
      return null;
    }
    return sel.getRangeAt(0).cloneRange();
  }

  function state() {
    const sel = selectionRange();
    savedRange = sel || (window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0).cloneRange() : null);
    const b = boundary();
    let quote = "";
    if (b) {
      const r = document.createRange();
      r.setStartBefore(b);
      r.setEnd(document.body, document.body.childNodes.length);
      const frag = r.cloneContents();
      frag.querySelectorAll?.(".moz-signature").forEach(s => s.remove());
      quote = toText(frag).slice(0, 8000);
    }
    return {
      selection: sel ? toText(sel.cloneContents()) : "",
      own: toText(ownRange().cloneContents()),
      quote,
    };
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function replace(text, target, plain) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (target == "own") {
      sel.addRange(ownRange());
    } else if (savedRange) {
      sel.addRange(savedRange);
    } else {
      const r = ownRange();
      r.collapse(false);
      sel.addRange(r);
    }
    document.body.focus?.();
    let ok;
    if (plain) {
      ok = document.execCommand("insertText", false, text);
    } else {
      const html = text
        .split(/\n{2,}/)
        .map(p => escapeHtml(p).replace(/\n/g, "<br>"))
        .join("<br><br>");
      ok = document.execCommand("insertHTML", false, target == "own" ? html + "<br><br>" : html);
    }
    savedRange = null;
    return ok;
  }

  browser.runtime.onMessage.addListener(msg => {
    switch (msg?.type) {
      case "ai-compose-state":
        return Promise.resolve(state());
      case "ai-compose-replace":
        return Promise.resolve(replace(String(msg.text || ""), msg.target, !!msg.plain));
    }
    return undefined;
  });
})();
