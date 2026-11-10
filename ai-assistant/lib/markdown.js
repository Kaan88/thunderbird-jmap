// A small Markdown renderer that builds DOM nodes (never innerHTML), so model
// output can't inject markup. It is re-run on the growing text while an answer
// streams, so it must be fast, tolerate incomplete input and never throw.
//
// Blocks: paragraphs (hard line breaks), ATX + setext headings (# -> h3),
// fenced code (``` and ~~~), blockquotes (nested, recursive), horizontal
// rules, GitHub tables, nested ordered/unordered lists, task items.
// Inline: **bold**, *italic*, _italic_, ***both***, ~~strike~~, `code`,
// ``code``, [links](url), <autolinks>, bare http(s) URLs, images (rendered as
// links, never loaded), backslash escapes. Only http(s) and mailto: links
// become clickable.

const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const MAX_DEPTH = 12;

function safeHref(url) {
  const u = String(url || "").trim();
  if (/\s/.test(u)) return null;
  if (/^https?:\/\/[^/\s]/i.test(u)) return u;
  if (/^mailto:[^\s]+$/i.test(u)) return u;
  return null;
}

function link(label, href, onLink, parentRender) {
  const a = document.createElement("a");
  if (parentRender) parentRender(a);
  else a.textContent = label;
  a.href = href;
  a.title = href;
  a.addEventListener("click", e => {
    e.preventDefault();
    onLink?.(href);
  });
  return a;
}

const isAlnum = ch => !!ch && /[\p{L}\p{N}]/u.test(ch);
const isSpace = ch => !ch || /\s/.test(ch);

// Finds the matching "]" for a "[" at `open`, honouring nesting and escapes.
function matchBracket(text, open) {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const ch = text[k];
    if (ch === "\\") {
      k++;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]" && --depth === 0) {
      return k;
    }
  }
  return -1;
}

// Parses "(url "title")" starting at `open` (the "("). Returns {url, end}.
function parseDest(text, open) {
  if (text[open] !== "(") return null;
  let k = open + 1;
  while (text[k] === " ") k++;
  let url = "";
  if (text[k] === "<") {
    const close = text.indexOf(">", k);
    if (close < 0) return null;
    url = text.slice(k + 1, close);
    k = close + 1;
  } else {
    let depth = 0;
    const start = k;
    while (k < text.length && !/\s/.test(text[k])) {
      if (text[k] === "(") depth++;
      else if (text[k] === ")") {
        if (!depth) break;
        depth--;
      }
      k++;
    }
    url = text.slice(start, k);
  }
  while (text[k] === " ") k++;
  if (text[k] === '"' || text[k] === "'") {
    const close = text.indexOf(text[k], k + 1);
    if (close < 0) return null;
    k = close + 1;
    while (text[k] === " ") k++;
  }
  if (text[k] !== ")") return null;
  return { url, end: k + 1 };
}

// Finds a closing emphasis run of exactly `n` chars `c` after `from`.
function findCloser(text, from, c, n) {
  let k = from;
  while ((k = text.indexOf(c, k)) >= 0) {
    if (text[k - 1] === "\\") {
      k++;
      continue;
    }
    let e = k;
    while (text[e] === c) e++;
    const len = e - k;
    if (len >= n && !isSpace(text[k - 1]) && k > from) {
      if (c !== "_" || !isAlnum(text[k + n])) {
        // Prefer a run of exactly n; for longer runs use its tail.
        return len === n ? k : e - n;
      }
    }
    k = e;
  }
  return -1;
}

function inline(text, parent, onLink, depth = 0) {
  if (depth > MAX_DEPTH) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  let buf = "";
  const flush = () => {
    if (buf) {
      parent.appendChild(document.createTextNode(buf));
      buf = "";
    }
  };
  const sub = (s, el) => inline(s, el, onLink, depth + 1);
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];

    if (ch === "\\" && i + 1 < n && PUNCT.includes(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      let e = i;
      while (text[e] === "`") e++;
      const run = e - i;
      let k = e;
      let close = -1;
      while ((k = text.indexOf("`", k)) >= 0) {
        let ke = k;
        while (text[ke] === "`") ke++;
        if (ke - k === run) {
          close = k;
          break;
        }
        k = ke;
      }
      if (close < 0) {
        buf += text.slice(i, e);
        i = e;
        continue;
      }
      let code = text.slice(e, close);
      if (/^ .*[^ ].* $/s.test(code)) code = code.slice(1, -1);
      flush();
      const c = document.createElement("code");
      c.textContent = code;
      parent.appendChild(c);
      i = close + run;
      continue;
    }

    if (ch === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/i.exec(
        text.slice(i, i + 2048)
      );
      if (m) {
        const href = safeHref(m[1].includes(":") ? m[1] : "mailto:" + m[1]);
        if (href) {
          flush();
          parent.appendChild(link(m[1].replace(/^mailto:/i, ""), href, onLink));
          i += m[0].length;
          continue;
        }
      }
    }

    if (ch === "[" || (ch === "!" && text[i + 1] === "[")) {
      const img = ch === "!";
      const open = img ? i + 1 : i;
      const close = matchBracket(text, open);
      const dest = close > 0 ? parseDest(text, close + 1) : null;
      if (dest) {
        const label = text.slice(open + 1, close);
        const href = safeHref(dest.url);
        flush();
        if (img) {
          const alt = label.trim() || "image";
          if (href) {
            const a = link(alt, href, onLink);
            a.className = "md-image";
            parent.appendChild(a);
          } else {
            parent.appendChild(document.createTextNode(alt));
          }
        } else if (href) {
          parent.appendChild(link(label, href, onLink, a => sub(label, a)));
        } else {
          sub(label, parent);
        }
        i = dest.end;
        continue;
      }
    }

    if (ch === "~" && text[i + 1] === "~" && !isSpace(text[i + 2])) {
      const close = text.indexOf("~~", i + 3);
      if (close > 0 && !isSpace(text[close - 1])) {
        flush();
        const d = document.createElement("del");
        sub(text.slice(i + 2, close), d);
        parent.appendChild(d);
        i = close + 2;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      let e = i;
      while (text[e] === ch) e++;
      const run = e - i;
      const opensOk =
        run <= 3 && !isSpace(text[e]) && (ch === "*" || !isAlnum(text[i - 1]));
      if (opensOk) {
        let done = false;
        for (let len = run; len >= 1 && !done; len--) {
          const close = findCloser(text, e, ch, len);
          if (close < 0) continue;
          // Leading delimiters not consumed by this pair stay literal.
          buf += ch.repeat(run - len);
          flush();
          const inner = text.slice(e, close);
          let node;
          if (len === 3) {
            node = document.createElement("strong");
            const em = document.createElement("em");
            sub(inner, em);
            node.appendChild(em);
          } else {
            node = document.createElement(len === 2 ? "strong" : "em");
            sub(inner, node);
          }
          parent.appendChild(node);
          i = close + len;
          done = true;
        }
        if (done) continue;
      }
      buf += text.slice(i, e);
      i = e;
      continue;
    }

    if ((ch === "h" || ch === "H") && !isAlnum(text[i - 1])) {
      const m = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_~]/i.exec(text.slice(i, i + 2048));
      if (m) {
        let url = m[0];
        // Keep balanced parentheses (e.g. wikipedia links).
        const rest = text.slice(i + url.length);
        const pm = /^\([^\s()<>]*\)/.exec(rest);
        if (pm) url += pm[0];
        flush();
        parent.appendChild(link(url, url, onLink));
        i += url.length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
}

// ---------------------------------------------------------------- blocks

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RE_ITEM = /^([ \t]*)([-*+•]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const RE_QUOTE = /^ {0,3}>/;
const RE_ALIGN = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

const indentOf = s => {
  let w = 0;
  for (const ch of s) {
    if (ch === " ") w++;
    else if (ch === "\t") w += 4 - (w % 4);
    else break;
  }
  return w;
};

// Removes `n` columns of leading whitespace.
function dedent(line, n) {
  let w = 0;
  let k = 0;
  while (k < line.length && w < n) {
    if (line[k] === " ") w++;
    else if (line[k] === "\t") w += 4 - (w % 4);
    else break;
    k++;
  }
  return line.slice(k);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (ch === "`") {
      inCode = !inCode;
      cur += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines, i) {
  return (
    lines[i].includes("|") &&
    i + 1 < lines.length &&
    lines[i + 1].includes("-") &&
    (lines[i + 1].includes("|") || lines[i].trim().startsWith("|")) &&
    RE_ALIGN.test(lines[i + 1])
  );
}

function startsBlock(lines, i) {
  const l = lines[i];
  return (
    RE_FENCE.test(l) ||
    RE_HR.test(l) ||
    RE_ATX.test(l) ||
    RE_QUOTE.test(l) ||
    (RE_ITEM.test(l) && RE_ITEM.exec(l)[3] !== undefined) ||
    isTableStart(lines, i)
  );
}

function renderBlocks(lines, container, opts, depth) {
  const { onLink, onFence } = opts;
  const inl = (t, el) => inline(t, el, onLink);
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement("p");
    para.forEach((l, k) => {
      if (k) p.appendChild(document.createElement("br"));
      inl(l.trim(), p);
    });
    container.appendChild(p);
    para = [];
  };
  const heading = (level, text) => {
    const h = document.createElement(`h${Math.min(6, level + 2)}`);
    inl(text, h);
    container.appendChild(h);
  };

  while (i < lines.length) {
    const line = lines[i];

    // Setext headings: a paragraph underlined with === or ---.
    if (para.length && /^ {0,3}(=+|-{2,})[ \t]*$/.test(line)) {
      const level = line.trim()[0] === "=" ? 1 : 2;
      const text = para.map(l => l.trim()).join(" ");
      para = [];
      heading(level, text);
      i++;
      continue;
    }

    const fence = RE_FENCE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1];
      const ind = indentOf(line);
      const lang = fence[2].toLowerCase();
      const code = [];
      i++;
      const closeRe = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      while (i < lines.length && !closeRe.test(lines[i])) {
        code.push(dedent(lines[i], ind));
        i++;
      }
      i++;
      const text = code.join("\n");
      const custom = onFence?.(lang, text);
      if (custom) {
        container.appendChild(custom);
      } else {
        const pre = document.createElement("pre");
        const c = document.createElement("code");
        if (lang) c.className = `language-${lang}`;
        c.textContent = text;
        pre.appendChild(c);
        container.appendChild(pre);
      }
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    const atx = RE_ATX.exec(line);
    if (atx) {
      flushPara();
      heading(atx[1].length, atx[2] || "");
      i++;
      continue;
    }

    if (RE_HR.test(line)) {
      flushPara();
      container.appendChild(document.createElement("hr"));
      i++;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      flushPara();
      const inner = [];
      while (i < lines.length && lines[i].trim()) {
        if (RE_QUOTE.test(lines[i])) {
          inner.push(lines[i].replace(/^ {0,3}> ?/, ""));
        } else if (inner.length && !startsBlock(lines, i)) {
          inner.push(lines[i]); // lazy continuation
        } else {
          break;
        }
        i++;
      }
      const bq = document.createElement("blockquote");
      if (depth < MAX_DEPTH) renderBlocks(inner, bq, opts, depth + 1);
      else bq.textContent = inner.join("\n");
      container.appendChild(bq);
      continue;
    }

    if (isTableStart(lines, i)) {
      flushPara();
      i = renderTable(lines, i, container, inl);
      continue;
    }

    const item = RE_ITEM.exec(line);
    if (item && (item[3] !== undefined || !para.length)) {
      flushPara();
      i = renderList(lines, i, container, opts, depth);
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
}

function renderTable(lines, i, container, inl) {
  const head = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]).map(c => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : "";
  });
  const cols = head.length;
  const wrap = document.createElement("div");
  wrap.className = "md-table";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const row = (cells, tag) => {
    const tr = document.createElement("tr");
    for (let c = 0; c < cols; c++) {
      const td = document.createElement(tag);
      if (aligns[c]) td.style.textAlign = aligns[c];
      inl(cells[c] || "", td);
      tr.appendChild(td);
    }
    return tr;
  };
  thead.appendChild(row(head, "th"));
  table.appendChild(thead);
  i += 2;
  const tbody = document.createElement("tbody");
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
    tbody.appendChild(row(splitRow(lines[i]), "td"));
    i++;
  }
  if (tbody.firstChild) table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
  return i;
}

// Indentation-based nested lists. Each open level keeps its own <ul>/<ol> and
// the lines of its current item; an item's lines are rendered (inline when
// they are a single paragraph, recursively otherwise) when the item ends or a
// nested list starts inside it.
function renderList(lines, i, container, opts, depth) {
  const stack = []; // {indent, content, el, ordered, li, buf}
  const inl = (t, el) => inline(t, el, opts.onLink);

  const flushItem = lvl => {
    if (!lvl.li || !lvl.buf.length) return;
    const buf = lvl.buf;
    lvl.buf = [];
    while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
    if (!buf.length) return;
    const simple = buf.every(l => l.trim()) && !buf.slice(1).some((_, k) => startsBlock(buf, k + 1));
    if (simple) {
      buf.forEach((l, k) => {
        if (k || lvl.li.childNodes.length > (lvl.task ? 1 : 0)) {
          lvl.li.appendChild(document.createElement("br"));
        }
        inl(l.trim(), lvl.li);
      });
    } else if (depth < MAX_DEPTH) {
      renderBlocks(buf, lvl.li, opts, depth + 1);
    } else {
      lvl.li.appendChild(document.createTextNode(buf.join("\n")));
    }
  };
  const newList = (parent, ordered, start, indent, content) => {
    const el = document.createElement(ordered ? "ol" : "ul");
    if (ordered && start !== 1) el.setAttribute("start", String(start));
    parent.appendChild(el);
    return { indent, content, el, ordered, li: null, buf: [] };
  };

  while (i < lines.length) {
    const line = lines[i];
    const top = stack[stack.length - 1];

    if (!line.trim()) {
      // A blank line continues the list only if more list content follows.
      let k = i + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k >= lines.length) break;
      const next = lines[k];
      if (!RE_ITEM.test(next) && indentOf(next) < (stack[0]?.content ?? 2)) break;
      if (top) top.buf.push("");
      i++;
      continue;
    }

    const item = RE_ITEM.exec(line);
    const ind = indentOf(line);
    // Inside an open fence in the current item, everything is code.
    const inFence = top && top.buf.filter(l => RE_FENCE.test(l)).length % 2 === 1;

    if (item && !inFence && !(top && ind >= top.content + 4)) {
      const ordered = /\d/.test(item[2]);
      const marker = ordered ? item[2].slice(-1) : item[2];
      const ws = /^[ \t]*/.exec(item[3] === undefined ? "" : line.slice(item[1].length + item[2].length))[0];
      const content = ind + item[2].length + Math.min(4, Math.max(1, ws.length));

      // Close deeper levels.
      while (stack.length > 1 && ind < stack[stack.length - 1].indent - 1) {
        flushItem(stack.pop());
      }
      let lvl = stack[stack.length - 1];
      if (!lvl) {
        lvl = newList(container, ordered, ordered ? parseInt(item[2], 10) : 1, ind, content);
        lvl.marker = marker;
        stack.push(lvl);
      } else if (ind >= lvl.indent + 2 && lvl.li) {
        flushItem(lvl);
        const child = newList(lvl.li, ordered, ordered ? parseInt(item[2], 10) : 1, ind, content);
        stack.push(child);
        lvl = child;
      } else {
        flushItem(lvl);
        if (lvl.marker !== marker) {
          const parent = lvl.el.parentNode || container;
          const repl = newList(parent, ordered, ordered ? parseInt(item[2], 10) : 1, ind, content);
          stack[stack.length - 1] = repl;
          lvl = repl;
        }
      }
      lvl.content = content;
      lvl.marker = marker;
      const li = document.createElement("li");
      lvl.li = li;
      lvl.task = false;
      let text = item[3] ?? "";
      const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(text);
      if (task) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.disabled = true;
        box.checked = task[1] !== " ";
        if (box.checked) box.setAttribute("checked", "");
        li.appendChild(box);
        li.className = "task";
        lvl.el.className = "contains-task-list";
        lvl.task = true;
        text = text.slice(task[0].length);
      }
      lvl.el.appendChild(li);
      lvl.buf = text ? [text] : [];
      i++;
      continue;
    }

    // Continuation line: belongs to the deepest level it is indented under.
    if (top && (ind >= 2 || inFence)) {
      while (stack.length > 1 && ind < stack[stack.length - 1].indent + 2 && !inFence) {
        flushItem(stack.pop());
      }
      const lvl = stack[stack.length - 1];
      lvl.buf.push(dedent(line, Math.min(ind, lvl.content)));
      i++;
      continue;
    }

    // Lazy paragraph continuation (no blank line before, not a new block).
    if (top && top.buf.length && top.buf[top.buf.length - 1].trim() && !startsBlock(lines, i)) {
      top.buf.push(line);
      i++;
      continue;
    }
    break;
  }
  while (stack.length) flushItem(stack.pop());
  return i;
}

/**
 * Renders markdown into `container`. `onFence(lang, code)` may return a node
 * to use for a fenced block (e.g. an email draft with buttons). `onLink(href)`
 * is called when a link is clicked.
 */
export function renderMarkdown(container, md, { onLink, onFence } = {}) {
  container.textContent = "";
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  try {
    renderBlocks(lines, container, { onLink, onFence }, 0);
  } catch (e) {
    // Never break the panel on odd input: fall back to plain text.
    console.error("renderMarkdown", e);
    container.textContent = "";
    const p = document.createElement("p");
    p.style.whiteSpace = "pre-wrap";
    p.textContent = String(md || "");
    container.appendChild(p);
  }
}
