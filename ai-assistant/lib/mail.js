// Reading mail, contacts and calendar data through Thunderbird's APIs.

const MAX_BODY = 12000;

export function shortDate(d) {
  if (!d) {
    return "";
  }
  const date = new Date(d);
  if (isNaN(date)) {
    return String(d);
  }
  // Local time with its offset, so "today" and "10:00" mean what the user sees.
  const pad = n => String(Math.abs(n)).padStart(2, "0");
  const off = -date.getTimezoneOffset();
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}` +
    `${off < 0 ? "-" : "+"}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

export function describeHeader(h) {
  return {
    id: h.id,
    date: shortDate(h.date),
    from: h.author,
    to: (h.recipients || []).slice(0, 5),
    cc: (h.ccList || []).slice(0, 5),
    subject: h.subject,
    folder: h.folder ? `${h.folder.name}` : undefined,
    folderPath: h.folder?.path,
    read: h.read,
    flagged: h.flagged,
    tags: h.tags?.length ? h.tags : undefined,
  };
}

function tidy(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function htmlToText(html) {
  try {
    return await messenger.messengerUtilities.convertToPlainText(html);
  } catch (e) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style").forEach(n => n.remove());
    return doc.body?.innerText || doc.body?.textContent || "";
  }
}

/** The readable text of a message, truncated. */
export async function messageBody(id, max = MAX_BODY) {
  let parts = [];
  try {
    parts = await messenger.messages.listInlineTextParts(id);
  } catch (e) {
    console.warn("listInlineTextParts failed", e);
  }
  let text = "";
  const plain = parts.filter(p => p.contentType == "text/plain");
  if (plain.length) {
    text = plain.map(p => p.content).join("\n\n");
  } else {
    const html = parts.filter(p => p.contentType == "text/html");
    for (const p of html) {
      text += (await htmlToText(p.content)) + "\n\n";
    }
  }
  text = tidy(text);
  if (text.length > max) {
    text = text.slice(0, max) + `\n[… ${text.length - max} more characters cut]`;
  }
  return text;
}

export async function attachmentsOf(id) {
  try {
    const list = await messenger.messages.listAttachments(id);
    return list.map(a => `${a.name} (${a.contentType}, ${Math.round((a.size || 0) / 1024)} KB)`);
  } catch (e) {
    return [];
  }
}

/** A message as text for the model, wrapped so it reads as data. */
export async function messageForModel(id, { max = MAX_BODY } = {}) {
  const h = await messenger.messages.get(id);
  const body = await messageBody(id, max);
  const att = await attachmentsOf(id);
  const lines = [
    `<email id="${h.id}">`,
    `From: ${h.author}`,
    `To: ${(h.recipients || []).join(", ")}`,
  ];
  if (h.ccList?.length) {
    lines.push(`Cc: ${h.ccList.join(", ")}`);
  }
  lines.push(`Date: ${shortDate(h.date)}`, `Subject: ${h.subject}`);
  if (h.folder) {
    lines.push(`Folder: ${h.folder.path}`);
  }
  if (att.length) {
    lines.push(`Attachments: ${att.join("; ")}`);
  }
  lines.push("", body || "(no text)", "</email>");
  return { header: h, text: lines.join("\n") };
}

// ---------------------------------------------------------------- vCard

function unescapeV(v) {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

export function escapeV(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

export function parseVCard(vcard) {
  const out = { emails: [], phones: [] };
  const lines = String(vcard || "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i < 0) {
      continue;
    }
    const key = line.slice(0, i).split(";")[0].split(".").pop().toUpperCase();
    const value = unescapeV(line.slice(i + 1));
    switch (key) {
      case "FN":
        out.name = value;
        break;
      case "EMAIL":
        out.emails.push(value);
        break;
      case "TEL":
        out.phones.push(value.replace(/^tel:/i, ""));
        break;
      case "ORG":
        out.organization = value.replace(/;/g, " ").trim();
        break;
      case "TITLE":
        out.title = value;
        break;
      case "NOTE":
        out.note = value.slice(0, 300);
        break;
    }
  }
  return out;
}

export function buildVCard({ name, email, phone, organization }) {
  const parts = String(name || "").trim().split(/\s+/);
  const last = parts.length > 1 ? parts.pop() : "";
  const first = parts.join(" ");
  const lines = ["BEGIN:VCARD", "VERSION:4.0", `FN:${escapeV(name || email || "")}`];
  lines.push(`N:${escapeV(last)};${escapeV(first)};;;`);
  if (email) {
    lines.push(`EMAIL;PREF=1:${escapeV(email)}`);
  }
  if (phone) {
    lines.push(`TEL;VALUE=TEXT:${escapeV(phone)}`);
  }
  if (organization) {
    lines.push(`ORG:${escapeV(organization)}`);
  }
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

// ---------------------------------------------------------------- folders

let folderCache = null;

export async function allFolders() {
  if (folderCache && Date.now() - folderCache.at < 60000) {
    return folderCache.list;
  }
  const accounts = await messenger.accounts.list(false);
  const names = Object.fromEntries(accounts.map(a => [a.id, a.name]));
  const folders = await messenger.folders.query({ isVirtual: false });
  const list = folders.map(f => ({
    id: f.id,
    name: f.name,
    path: f.path,
    account: names[f.accountId] || f.accountId,
    accountId: f.accountId,
    specialUse: f.specialUse?.length ? f.specialUse : undefined,
  }));
  folderCache = { at: Date.now(), list };
  return list;
}

export function clearFolderCache() {
  folderCache = null;
}

/** Finds a folder by id, path, "Account/path" or (case-insensitive) name. */
export async function findFolder(spec) {
  const list = await allFolders();
  const s = String(spec || "").trim();
  if (!s) {
    return null;
  }
  const lower = s.toLowerCase();
  return (
    list.find(f => f.id == s) ||
    list.find(f => f.path == s || f.path == "/" + s) ||
    list.find(f => f.name.toLowerCase() == lower) ||
    list.find(f => `${f.account}${f.path}`.toLowerCase() == lower || `${f.account}/${f.path.replace(/^\//, "")}`.toLowerCase() == lower) ||
    list.find(f => f.path.toLowerCase().endsWith("/" + lower)) ||
    null
  );
}
