// Runs in the displayed message. Tells the assistant panel which passage is
// highlighted, so the user can ask about that part. Reads nothing else.
(() => {
  let last = "";
  let timer = 0;
  const current = () => String(window.getSelection() || "").trim().slice(0, 4000);
  browser.runtime.sendMessage({ type: "ai-message-shown" }).catch(() => {});

  document.addEventListener("selectionchange", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const text = current();
      if (text != last) {
        last = text;
        browser.runtime.sendMessage({ type: "ai-selection", text }).catch(() => {});
      }
    }, 250);
  });

  browser.runtime.onMessage.addListener(msg => {
    if (msg?.type == "ai-get-selection") {
      return Promise.resolve(current());
    }
    return undefined;
  });
})();
