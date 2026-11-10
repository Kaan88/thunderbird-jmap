// Tools the model may call, as one registry. Each tool says how risky it is:
//   read    - looks something up (needs "look things up" on)
//   ui      - only changes what Thunderbird shows (opens a tab, a folder)
//   change  - changes data; asked first in "Ask me first" mode, runs at once
//             in "Act on its own" mode
//   confirm - sends mail or destroys data; the user is ALWAYS asked, whatever
//             the setting, and sees exactly what will happen
// `risk` may be a function of the arguments (raw JMAP calls).

import {
  allFolders,
  attachmentsOf,
  buildVCard,
  clearFolderCache,
  describeHeader,
  findFolder,
  messageForModel,
  parseVCard,
} from "./mail.js";

const MAX_IDS = 100;
const UNCONFIRMED = " The calendar didn't confirm this change; it has probably been saved. Tell the user briefly to check.";
const MAX_RESULT = 60000;

const json = v => JSON.stringify(v, null, 1);
const cap = (text, max = MAX_RESULT) =>
  text.length > max ? `${text.slice(0, max)}\n… (cut off, ${text.length - max} more characters)` : text;

const idsSchema = {
  type: "array",
  items: { type: "integer" },
  description: "Message ids from search_mail, list_messages, read_message or the open message.",
};
const str = description => ({ type: "string", ...(description ? { description } : {}) });
const bool = description => ({ type: "boolean", ...(description ? { description } : {}) });
const int = description => ({ type: "integer", ...(description ? { description } : {}) });
const strList = description => ({ type: "array", items: { type: "string" }, ...(description ? { description } : {}) });
const obj = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}) });

// ---------------------------------------------------------------- helpers

function checkIds(ids) {
  if (!Array.isArray(ids) || !ids.length) {
    throw new Error("No message ids given.");
  }
  if (ids.length > MAX_IDS) {
    throw new Error(`At most ${MAX_IDS} messages per call.`);
  }
  return ids.map(Number);
}

async function subjects(ids) {
  const out = [];
  for (const id of ids.slice(0, 4)) {
    try {
      const h = await messenger.messages.get(id);
      out.push(`“${h.subject || "(no subject)"}”`);
    } catch (e) {
      out.push(`#${id}`);
    }
  }
  if (ids.length > 4) {
    out.push(`and ${ids.length - 4} more`);
  }
  return out.join(", ");
}

const daysAgo = n => new Date(Date.now() - n * 86400000);

async function folderOrThrow(spec) {
  const f = await findFolder(spec);
  if (!f) {
    throw new Error(`No folder called "${spec}". Use list_folders.`);
  }
  return f;
}

async function collect(page, limit) {
  let messages = page.messages || [];
  if (page.id) {
    try {
      await messenger.messages.abortList(page.id);
    } catch (e) {}
  }
  messages.sort((x, y) => new Date(y.date) - new Date(x.date));
  return messages.slice(0, limit);
}

async function tagKeys(names) {
  const tags = await (messenger.messages.tags?.list?.() ?? messenger.messages.listTags());
  return (names || []).map(n => {
    const s = String(n).toLowerCase();
    const t = tags.find(x => x.key.toLowerCase() == s || x.tag.toLowerCase() == s);
    if (!t) {
      throw new Error(`No tag called "${n}". Use list_tags or create_tag.`);
    }
    return t.key;
  });
}

async function identityIdFor(email) {
  if (!email) {
    return undefined;
  }
  const s = email.toLowerCase();
  for (const account of await messenger.accounts.list(false)) {
    for (const i of account.identities || []) {
      if (i.email?.toLowerCase() == s || i.id == email) {
        return i.id;
      }
    }
  }
  throw new Error(`No identity with the address ${email}. Use list_accounts.`);
}

async function textOf(fileOrString) {
  if (typeof fileOrString == "string") {
    return fileOrString;
  }
  return fileOrString?.text ? fileOrString.text() : String(fileOrString ?? "");
}

const TEXTISH = /^(text\/|application\/(json|xml|.*\+xml|.*\+json|x-sh|javascript|ics|pgp-keys)|message\/)|calendar|vcard/i;

// vCard: replace whole properties, keep everything else as it was.
function patchVCard(vcard, changes) {
  const esc = v => String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  const lines = String(vcard).replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter(Boolean);
  const set = (key, values) => {
    const keep = lines.filter(l => l.split(":")[0].split(";")[0].split(".").pop().toUpperCase() != key);
    lines.length = 0;
    lines.push(...keep);
    const end = lines.findIndex(l => l.toUpperCase() == "END:VCARD");
    const add = values.filter(v => v != null && v !== "").map((v, i) => {
      if (key == "EMAIL") return `EMAIL${i == 0 ? ";PREF=1" : ""}:${esc(v)}`;
      if (key == "TEL") return `TEL;VALUE=TEXT:${esc(v)}`;
      return `${key}:${esc(v)}`;
    });
    lines.splice(end < 0 ? lines.length : end, 0, ...add);
  };
  if (changes.name != null) {
    set("FN", [changes.name]);
    const parts = changes.name.trim().split(/\s+/);
    const last = parts.length > 1 ? parts.pop() : "";
    set("N", []);
    const end = lines.findIndex(l => l.toUpperCase() == "END:VCARD");
    lines.splice(end, 0, `N:${esc(last)};${esc(parts.join(" "))};;;`);
  }
  if (changes.emails) set("EMAIL", changes.emails);
  if (changes.phones) set("TEL", changes.phones);
  if (changes.organization != null) set("ORG", [changes.organization]);
  if (changes.title != null) set("TITLE", [changes.title]);
  if (changes.note != null) set("NOTE", [changes.note]);
  return lines.join("\r\n");
}

async function writableBook(name) {
  const books = (await messenger.addressBooks.list(false)).filter(b => !b.readOnly);
  const book = (name && books.find(b => b.name.toLowerCase() == String(name).toLowerCase() || b.id == name)) || books.find(b => !b.remote) || books[0];
  if (!book) {
    throw new Error("No address book can take changes.");
  }
  return book;
}

async function findList(spec) {
  for (const book of await messenger.addressBooks.list(false)) {
    for (const l of await messenger.mailingLists.list(book.id)) {
      if (l.id == spec || l.name.toLowerCase() == String(spec).toLowerCase()) {
        return l;
      }
    }
  }
  throw new Error(`No mailing list called "${spec}".`);
}

// ---------------------------------------------------------------- composing

function textToHtmlParagraphs(doc, text) {
  const frag = doc.createDocumentFragment();
  for (const para of String(text).split(/\n{2,}/)) {
    const p = doc.createElement("p");
    para.split("\n").forEach((line, i) => {
      if (i) p.appendChild(doc.createElement("br"));
      p.appendChild(doc.createTextNode(line));
    });
    frag.appendChild(p);
  }
  return frag;
}

/** Puts `text` at the top of a freshly opened compose window. */
export async function insertIntoCompose(tabId, text) {
  const details = await messenger.compose.getComposeDetails(tabId);
  if (details.isPlainText) {
    await messenger.compose.setComposeDetails(tabId, {
      plainTextBody: `${text}\n\n${details.plainTextBody || ""}`,
    });
    return;
  }
  const doc = new DOMParser().parseFromString(details.body || "<html><body></body></html>", "text/html");
  doc.body.insertBefore(textToHtmlParagraphs(doc, text), doc.body.firstChild);
  await messenger.compose.setComposeDetails(tabId, {
    body: "<!DOCTYPE html>\n" + doc.documentElement.outerHTML,
  });
}

// Thunderbird can't compose without a sending identity (its own Reply button
// is disabled then), and some builds crash if an add-on tries anyway.
async function ensureIdentity() {
  const accounts = await messenger.accounts.list(false);
  if (!accounts.some(a => a.identities?.length)) {
    throw new Error("Set up an email account in Thunderbird first; there is no address to write from.");
  }
}

export async function openReply(messageId, body, replyAll = false, extra = {}) {
  await ensureIdentity();
  const tab = await messenger.compose.beginReply(messageId, replyAll ? "replyToAll" : "replyToSender", extra);
  if (body) {
    await insertIntoCompose(tab.id, body);
  }
  return tab;
}

export async function openNewMessage(details, body) {
  await ensureIdentity();
  const tab = await messenger.compose.beginNew(details);
  if (body) {
    await insertIntoCompose(tab.id, body);
  }
  return tab;
}

async function openForward(messageId, details, body) {
  await ensureIdentity();
  const tab = await messenger.compose.beginForward(messageId, "forwardInline", details);
  if (body) {
    await insertIntoCompose(tab.id, body);
  }
  return tab;
}

/** Opens the right kind of composer for a send/draft/open request. */
async function composeFor(a) {
  const details = {};
  if (a.to) details.to = a.to;
  if (a.cc) details.cc = a.cc;
  if (a.bcc) details.bcc = a.bcc;
  if (a.subject) details.subject = a.subject;
  const identityId = await identityIdFor(a.from);
  if (identityId) details.identityId = identityId;
  if (a.replyTo) {
    return openReply(Number(a.replyTo), a.body, !!a.replyAll, details);
  }
  if (a.forward) {
    return openForward(Number(a.forward), details, a.body);
  }
  return openNewMessage(details, a.body);
}

function describeMail(a, verb) {
  const kind = a.replyTo ? (a.replyAll ? "reply to all" : "reply") : a.forward ? "forward" : "new message";
  const to = [...(a.to || []), ...(a.cc || []).map(x => `cc ${x}`), ...(a.bcc || []).map(x => `bcc ${x}`)];
  return `${verb} ${kind}${a.subject ? ` “${a.subject}”` : ""}${to.length ? ` to ${to.join(", ")}` : ""}${a.from ? ` from ${a.from}` : ""}`;
}

const composeParams = {
  to: strList("Recipients. For replies, leave empty to answer the sender."),
  cc: strList(),
  bcc: strList(),
  subject: str("Subject (replies and forwards get one automatically)."),
  body: str("The text you write. Quoted originals are added by Thunderbird."),
  from: str("Sending address (an identity from list_accounts); default identity if omitted."),
  replyTo: int("Message id to reply to."),
  replyAll: bool(),
  forward: int("Message id to forward inline."),
};

// ---------------------------------------------------------------- JMAP

const JMAP_READ = /\/(get|query|changes|queryChanges|parse|lookup|validate|getAvailability|echo)$/;

function jmapRisk(a) {
  const calls = Array.isArray(a.calls) ? a.calls : [];
  let risk = "read";
  for (const c of calls) {
    const name = String(c?.name || "");
    if (JMAP_READ.test(name)) {
      continue;
    }
    const args = c?.args || {};
    const destroys = Array.isArray(args.destroy) ? args.destroy.length : args.destroy ? 1 : 0;
    if (name == "EmailSubmission/set" || destroys || args.onDestroyRemoveEmails || name == "Email/import") {
      return "confirm";
    }
    risk = "change";
  }
  return risk;
}

function describeJmap(a) {
  const calls = (a.calls || []).map(c => {
    const args = c.args || {};
    const n = k => (Array.isArray(args[k]) ? args[k].length : args[k] ? Object.keys(args[k]).length : 0);
    const counts = c.name?.endsWith("/set")
      ? ` (create ${n("create")}, update ${n("update")}, destroy ${n("destroy")})`
      : "";
    return `${c.name}${counts}`;
  });
  return `JMAP${a.account ? ` on ${a.account}` : ""}: ${calls.join(", ")}${(a.calls || []).some(c => c.name == "EmailSubmission/set") ? " — this SENDS mail" : ""}`;
}

// ---------------------------------------------------------------- registry

export const TOOLS = [
  // ----- mail: reading
  {
    name: "search_mail",
    risk: "read",
    description:
      "Search the user's mail in all accounts. Returns up to `limit` messages, newest first, with ids for read_message and actions. Combine fields to narrow down.",
    parameters: obj({
      text: str("Words anywhere: subject, body or sender."),
      body: str("Words in the body only."),
      from: str("Part of the sender's name or address."),
      to: str("Part of a recipient's name or address."),
      subject: str("Part of the subject."),
      unread: bool(),
      flagged: bool("Starred only."),
      hasAttachment: bool(),
      tag: str("Tag name or key."),
      days: int("Only the last N days."),
      since: str("ISO date: only on/after."),
      before: str("ISO date: only before."),
      folder: str("Folder name or path, e.g. Inbox or Work/Clients."),
      account: str("Account name or id."),
      limit: int("1-100, default 20."),
    }),
    async run(a) {
      const limit = Math.max(1, Math.min(100, a.limit || 20));
      const q = { messagesPerPage: 250, autoPaginationTimeout: 0 };
      if (a.text) q.fullText = a.text;
      if (a.body) q.body = a.body;
      if (a.from) q.author = a.from;
      if (a.to) q.recipients = a.to;
      if (a.subject) q.subject = a.subject;
      if (a.unread !== undefined) q.unread = a.unread;
      if (a.flagged !== undefined) q.flagged = a.flagged;
      if (a.hasAttachment !== undefined) q.attachment = a.hasAttachment;
      if (a.tag) q.tags = { mode: "any", tags: Object.fromEntries((await tagKeys([a.tag])).map(k => [k, true])) };
      if (a.days) q.fromDate = daysAgo(a.days);
      if (a.since) q.fromDate = new Date(a.since);
      if (a.before) q.toDate = new Date(a.before);
      if (a.folder) {
        q.folderId = (await folderOrThrow(a.folder)).id;
        q.includeSubFolders = true;
      }
      if (a.account) {
        const acc = (await messenger.accounts.list(false)).find(x => x.id == a.account || x.name.toLowerCase() == a.account.toLowerCase());
        if (!acc) throw new Error(`No account called "${a.account}".`);
        q.accountId = acc.id;
      }
      if (Object.keys(q).length == 2) {
        q.fromDate = daysAgo(30);
      }
      const messages = await collect(await messenger.messages.query(q), limit);
      return { content: messages.length ? json(messages.map(describeHeader)) : "No messages found.", found: messages };
    },
  },
  {
    name: "list_messages",
    risk: "read",
    description: "List the newest messages in one folder.",
    parameters: obj({ folder: str("Folder name or path."), limit: int("1-100, default 25."), unreadOnly: bool() }, ["folder"]),
    async run(a) {
      const f = await folderOrThrow(a.folder);
      const limit = Math.max(1, Math.min(100, a.limit || 25));
      let messages = [];
      for (const days of [14, 90, 730, null]) {
        const q = { folderId: f.id, messagesPerPage: 500, autoPaginationTimeout: 0 };
        if (days) q.fromDate = daysAgo(days);
        if (a.unreadOnly) q.unread = true;
        messages = await collect(await messenger.messages.query(q), limit);
        if (messages.length >= limit) break;
      }
      return { content: messages.length ? json(messages.map(describeHeader)) : `No messages in ${f.path}.` };
    },
  },
  {
    name: "read_message",
    risk: "read",
    description: "Read one message: headers, attachment list and text. Set headers=true for all raw headers, raw=true for the full source.",
    parameters: obj({ id: int(), headers: bool(), raw: bool() }, ["id"]),
    async run(a) {
      const id = Number(a.id);
      if (a.raw) {
        const raw = await textOf(await messenger.messages.getRaw(id, { decrypt: true }).catch(() => messenger.messages.getRaw(id)));
        return { content: cap(raw) };
      }
      let { text } = await messageForModel(id);
      if (a.headers) {
        const full = await messenger.messages.getFull(id);
        const h = Object.entries(full.headers || {}).map(([k, v]) => `${k}: ${[].concat(v).join(" | ")}`).join("\n");
        text = `${text}\n\n<all-headers>\n${cap(h, 20000)}\n</all-headers>`;
      }
      return { content: text };
    },
  },
  {
    name: "read_attachment",
    risk: "read",
    description: "Read an attachment of a message. Text-like files (txt, csv, json, xml, ics, vcf, eml, html) are returned as text; others only as name, type and size.",
    parameters: obj({ id: int("Message id."), name: str("Attachment file name, or its part name.") }, ["id", "name"]),
    async run(a) {
      const list = await messenger.messages.listAttachments(Number(a.id));
      const att = list.find(x => x.partName == a.name) || list.find(x => x.name == a.name) || list.find(x => x.name?.toLowerCase().includes(String(a.name).toLowerCase()));
      if (!att) {
        return { content: `No attachment "${a.name}". It has: ${list.map(x => x.name).join(", ") || "none"}.`, isError: true };
      }
      if (!TEXTISH.test(att.contentType || "") && !/\.(txt|csv|md|json|xml|ics|vcf|eml|html?|log|ya?ml)$/i.test(att.name || "")) {
        return { content: `${att.name}: ${att.contentType}, ${att.size} bytes. Not a text file, so it can't be read here.` };
      }
      const file = await messenger.messages.getAttachmentFile(Number(a.id), att.partName);
      return { content: `<attachment name="${att.name}" type="${att.contentType}">\n${cap(await file.text())}\n</attachment>` };
    },
  },
  {
    name: "list_folders",
    risk: "read",
    description: "List all mail folders with paths and accounts. counts=true adds total/unread counts (slower).",
    parameters: obj({ counts: bool(), account: str() }),
    async run(a) {
      let list = await allFolders();
      if (a.account) {
        const s = a.account.toLowerCase();
        list = list.filter(f => f.accountId == a.account || String(f.account).toLowerCase() == s);
      }
      list = list.slice(0, 400);
      if (a.counts) {
        list = await Promise.all(
          list.map(async f => {
            try {
              const info = await messenger.folders.getFolderInfo(f.id);
              return { ...f, total: info.totalMessageCount, unread: info.unreadMessageCount };
            } catch (e) {
              return f;
            }
          })
        );
      }
      return { content: json(list) };
    },
  },
  {
    name: "list_accounts",
    risk: "read",
    description: "List mail accounts (type, e.g. jmap/imap/pop3) and their sending identities.",
    parameters: obj({}),
    async run() {
      const accounts = await messenger.accounts.list(false);
      return {
        content: json(
          accounts.map(x => ({
            id: x.id,
            name: x.name,
            type: x.type,
            identities: (x.identities || []).map(i => ({ id: i.id, name: i.name, email: i.email, label: i.label || undefined })),
          }))
        ),
      };
    },
  },
  {
    name: "list_tags",
    risk: "read",
    description: "List the message tags (key, name, color).",
    parameters: obj({}),
    async run() {
      return { content: json(await (messenger.messages.tags?.list?.() ?? messenger.messages.listTags())) };
    },
  },

  // ----- mail: changing
  {
    name: "archive_messages",
    risk: "change",
    description: "Archive messages.",
    parameters: obj({ ids: idsSchema }, ["ids"]),
    describe: async a => `Archive ${await subjects(checkIds(a.ids))}`,
    async run(a) {
      await messenger.messages.archive(checkIds(a.ids));
      return { content: "Archived." };
    },
  },
  {
    name: "move_messages",
    risk: "change",
    description: "Move messages to another folder (name or path from list_folders).",
    parameters: obj({ ids: idsSchema, folder: str() }, ["ids", "folder"]),
    describe: async a => `Move ${await subjects(checkIds(a.ids))} to ${a.folder}`,
    async run(a) {
      const f = await folderOrThrow(a.folder);
      await messenger.messages.move(checkIds(a.ids), f.id, { isUserAction: true });
      return { content: `Moved to ${f.path}.` };
    },
  },
  {
    name: "copy_messages",
    risk: "change",
    description: "Copy messages to another folder.",
    parameters: obj({ ids: idsSchema, folder: str() }, ["ids", "folder"]),
    describe: async a => `Copy ${await subjects(checkIds(a.ids))} to ${a.folder}`,
    async run(a) {
      const f = await folderOrThrow(a.folder);
      await messenger.messages.copy(checkIds(a.ids), f.id);
      return { content: `Copied to ${f.path}.` };
    },
  },
  {
    name: "mark_messages",
    risk: "change",
    description: "Mark messages read/unread, starred or junk, and add or remove tags. Give only what changes.",
    parameters: obj({
      ids: idsSchema,
      read: bool(),
      flagged: bool("true = starred"),
      junk: bool(),
      addTags: strList("Tag names or keys to add."),
      removeTags: strList("Tag names or keys to remove."),
    }, ["ids"]),
    async describe(a) {
      const what = [];
      if (a.read !== undefined) what.push(a.read ? "read" : "unread");
      if (a.flagged !== undefined) what.push(a.flagged ? "starred" : "not starred");
      if (a.junk !== undefined) what.push(a.junk ? "junk" : "not junk");
      if (a.addTags?.length) what.push(`tagged ${a.addTags.join(", ")}`);
      if (a.removeTags?.length) what.push(`without tag ${a.removeTags.join(", ")}`);
      return `Mark ${await subjects(checkIds(a.ids))} as ${what.join(", ") || "…"}`;
    },
    async run(a) {
      const props = {};
      for (const k of ["read", "flagged", "junk"]) {
        if (typeof a[k] == "boolean") props[k] = a[k];
      }
      const add = await tagKeys(a.addTags);
      const remove = await tagKeys(a.removeTags);
      for (const id of checkIds(a.ids)) {
        const p = { ...props };
        if (add.length || remove.length) {
          const h = await messenger.messages.get(id);
          p.tags = [...new Set([...(h.tags || []), ...add])].filter(t => !remove.includes(t));
        }
        await messenger.messages.update(id, p);
      }
      return { content: "Done." };
    },
  },
  {
    name: "delete_messages",
    risk: "confirm",
    description: "Delete messages: to the Trash, or permanently with permanent=true. The user is always asked first. Only when the user asked to delete.",
    parameters: obj({ ids: idsSchema, permanent: bool("Skip the Trash. Cannot be undone.") }, ["ids"]),
    describe: async a => `${a.permanent ? "PERMANENTLY delete (cannot be undone)" : "Move to the Trash:"} ${await subjects(checkIds(a.ids))}`,
    confirmLabel: a => (a.permanent ? "Delete permanently" : "Move to Trash"),
    async run(a) {
      await messenger.messages.delete(checkIds(a.ids), { deletePermanently: !!a.permanent, isUserAction: true });
      return { content: a.permanent ? "Deleted permanently." : "Moved to the Trash." };
    },
  },
  {
    name: "create_tag",
    risk: "change",
    description: "Create a new message tag.",
    parameters: obj({ name: str(), color: str("Hex color like #3366FF.") }, ["name"]),
    describe: a => `Create tag “${a.name}”`,
    async run(a) {
      const key = String(a.name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `tag${Date.now()}`;
      const create = messenger.messages.tags?.create ?? messenger.messages.createTag;
      await create(key, a.name, a.color || "#3366FF");
      return { content: `Created tag ${a.name} (key ${key}).` };
    },
  },

  // ----- folders
  {
    name: "create_folder",
    risk: "change",
    description: "Create a mail folder under a parent folder (or at the top of an account: give the account name as parent).",
    parameters: obj({ parent: str("Parent folder path/name, or an account name."), name: str() }, ["parent", "name"]),
    describe: a => `Create folder “${a.name}” in ${a.parent}`,
    async run(a) {
      let parent = (await findFolder(a.parent))?.id;
      if (!parent) {
        const acc = (await messenger.accounts.list(false)).find(x => x.id == a.parent || x.name.toLowerCase() == String(a.parent).toLowerCase());
        if (!acc) throw new Error(`No folder or account called "${a.parent}".`);
        parent = acc.rootFolder?.id ?? acc.id;
      }
      const f = await messenger.folders.create(parent, a.name);
      clearFolderCache();
      return { content: `Created ${f.path}.` };
    },
  },
  {
    name: "rename_folder",
    risk: "change",
    description: "Rename a mail folder.",
    parameters: obj({ folder: str(), name: str("New name.") }, ["folder", "name"]),
    describe: a => `Rename folder ${a.folder} to “${a.name}”`,
    async run(a) {
      const f = await messenger.folders.rename((await folderOrThrow(a.folder)).id, a.name);
      clearFolderCache();
      return { content: `Renamed to ${f.path}.` };
    },
  },
  {
    name: "move_folder",
    risk: "change",
    description: "Move a mail folder into another folder.",
    parameters: obj({ folder: str(), destination: str() }, ["folder", "destination"]),
    describe: a => `Move folder ${a.folder} into ${a.destination}`,
    async run(a) {
      const f = await messenger.folders.move((await folderOrThrow(a.folder)).id, (await folderOrThrow(a.destination)).id);
      clearFolderCache();
      return { content: `Moved to ${f.path}.` };
    },
  },
  {
    name: "delete_folder",
    risk: "confirm",
    description: "Delete a mail folder and everything in it. The user is always asked first.",
    parameters: obj({ folder: str() }, ["folder"]),
    describe: a => `Delete the folder ${a.folder} with all its messages`,
    confirmLabel: () => "Delete folder",
    async run(a) {
      await messenger.folders.delete((await folderOrThrow(a.folder)).id);
      clearFolderCache();
      return { content: "Folder deleted." };
    },
  },
  {
    name: "mark_folder_read",
    risk: "change",
    description: "Mark every message in a folder as read.",
    parameters: obj({ folder: str() }, ["folder"]),
    describe: a => `Mark everything in ${a.folder} as read`,
    async run(a) {
      await messenger.folders.markAsRead((await folderOrThrow(a.folder)).id);
      return { content: "Done." };
    },
  },

  // ----- writing and sending
  {
    name: "open_compose",
    risk: "change",
    description:
      "Open a new message, reply or forward in the composer with your text. It is NOT sent; the user reviews it. Prefer this over send_message unless the user clearly asked you to send.",
    parameters: obj(composeParams),
    describe: a => describeMail(a, "Open a") + " in the composer (not sent)",
    async run(a) {
      await composeFor(a);
      return { content: "Open in the composer. The user will review and send it." };
    },
  },
  {
    name: "save_draft",
    timeout: 60000,
    risk: "change",
    description: "Write a message, reply or forward and save it to Drafts without sending.",
    parameters: obj(composeParams),
    describe: a => describeMail(a, "Save a draft") ,
    async run(a) {
      const tab = await composeFor(a);
      await messenger.compose.saveMessage(tab.id, { mode: "draft" });
      try {
        await messenger.tabs.remove(tab.id);
      } catch (e) {}
      return { content: "Saved to Drafts." };
    },
  },
  {
    name: "send_message",
    timeout: 180000,
    risk: "confirm",
    description:
      "Send an email (new, reply or forward) right away. The user always sees the full message and must click Send first. Only when the user asked you to send.",
    parameters: obj(composeParams, ["body"]),
    describe: a => describeMail(a, "Send"),
    details: a => `${a.subject ? `Subject: ${a.subject}\n` : ""}${a.to?.length ? `To: ${a.to.join(", ")}\n` : ""}${a.cc?.length ? `Cc: ${a.cc.join(", ")}\n` : ""}${a.bcc?.length ? `Bcc: ${a.bcc.join(", ")}\n` : ""}\n${a.body || ""}`,
    confirmLabel: () => "Send",
    async run(a) {
      const tab = await composeFor(a);
      let result;
      try {
        result = await messenger.compose.sendMessage(tab.id, { mode: "sendNow" });
      } catch (e) {
        throw new Error(`Sending failed; the message is still open in the composer. ${e.message}`);
      }
      // Some failures (e.g. the server refusing) only show Thunderbird's own
      // error dialog; the composer then stays open.
      // A failed send resolves with { headerMessageId: null, messages: [] }.
      const sent = result && typeof result == "object" ? !!result.headerMessageId : result !== false;
      if (!sent) {
        return {
          content: "Sending did NOT complete: Thunderbird reported a problem (see its error message). The message is still open in the composer. Tell the user it was not sent.",
          isError: true,
        };
      }
      return { content: "Sent." };
    },
  },

  // ----- contacts
  {
    name: "list_address_books",
    risk: "read",
    description: "List address books.",
    parameters: obj({}),
    async run() {
      const books = await messenger.addressBooks.list(false);
      return { content: json(books.map(b => ({ id: b.id, name: b.name, readOnly: !!b.readOnly, remote: !!b.remote }))) };
    },
  },
  {
    name: "search_contacts",
    risk: "read",
    description: "Find contacts by name, address or company. Returns ids for get_contact/update_contact.",
    parameters: obj({ query: str() }, ["query"]),
    async run(a) {
      const nodes = await messenger.addressBooks.contacts.query({ searchString: a.query });
      const books = await messenger.addressBooks.list(false);
      const names = Object.fromEntries(books.map(b => [b.id, b.name]));
      const out = nodes.slice(0, 50).map(n => ({ id: n.id, ...parseVCard(n.vCard), addressBook: names[n.parentId] }));
      return { content: out.length ? json(out) : "No contacts found." };
    },
  },
  {
    name: "get_contact",
    risk: "read",
    description: "Get one contact with its full vCard.",
    parameters: obj({ id: str() }, ["id"]),
    async run(a) {
      const n = await messenger.addressBooks.contacts.get(a.id);
      return { content: `${json(parseVCard(n.vCard))}\n\nvCard:\n${n.vCard}` };
    },
  },
  {
    name: "create_contact",
    risk: "change",
    description: "Add a contact.",
    parameters: obj({
      name: str(),
      email: str(),
      phone: str(),
      organization: str(),
      title: str(),
      note: str(),
      addressBook: str("Address book name, optional."),
    }, ["name"]),
    describe: a => `Add contact ${a.name}${a.email ? ` <${a.email}>` : ""}`,
    async run(a) {
      const book = await writableBook(a.addressBook);
      let vcard = buildVCard(a);
      if (a.title || a.note) vcard = patchVCard(vcard, { title: a.title, note: a.note });
      await messenger.addressBooks.contacts.create(book.id, vcard);
      return { content: `Added to ${book.name}.` };
    },
  },
  {
    name: "update_contact",
    risk: "change",
    description: "Change a contact. Give only the fields to replace; emails/phones replace the whole list.",
    parameters: obj({
      id: str(),
      name: str(),
      emails: strList(),
      phones: strList(),
      organization: str(),
      title: str(),
      note: str(),
    }, ["id"]),
    async describe(a) {
      let who = a.id;
      try {
        who = parseVCard((await messenger.addressBooks.contacts.get(a.id)).vCard).name || who;
      } catch (e) {}
      const fields = Object.keys(a).filter(k => k != "id");
      return `Update contact ${who}: ${fields.join(", ")}`;
    },
    async run(a) {
      const n = await messenger.addressBooks.contacts.get(a.id);
      await messenger.addressBooks.contacts.update(a.id, patchVCard(n.vCard, a));
      return { content: "Contact updated." };
    },
  },
  {
    name: "delete_contact",
    risk: "confirm",
    description: "Delete a contact. The user is always asked first.",
    parameters: obj({ id: str() }, ["id"]),
    async describe(a) {
      let who = a.id;
      try {
        who = parseVCard((await messenger.addressBooks.contacts.get(a.id)).vCard).name || who;
      } catch (e) {}
      return `Delete contact ${who}`;
    },
    confirmLabel: () => "Delete contact",
    async run(a) {
      await messenger.addressBooks.contacts.delete(a.id);
      return { content: "Contact deleted." };
    },
  },
  {
    name: "list_mailing_lists",
    risk: "read",
    description: "List mailing lists (contact groups) with their members.",
    parameters: obj({}),
    async run() {
      const out = [];
      for (const book of await messenger.addressBooks.list(false)) {
        for (const l of await messenger.mailingLists.list(book.id)) {
          const members = await messenger.mailingLists.listMembers(l.id);
          out.push({
            id: l.id,
            name: l.name,
            addressBook: book.name,
            members: members.map(m => ({ id: m.id, ...parseVCard(m.vCard) })).map(m => `${m.name || ""} <${m.emails[0] || ""}> (${m.id})`),
          });
        }
      }
      return { content: out.length ? json(out) : "No mailing lists." };
    },
  },
  {
    name: "edit_mailing_list",
    risk: "change",
    description: "Create a mailing list (give name, optional addressBook) or add/remove contacts (by contact id) to an existing one.",
    parameters: obj({
      list: str("Existing list name or id; omit to create a new one."),
      name: str("Name for a new list."),
      addressBook: str(),
      add: strList("Contact ids to add."),
      remove: strList("Contact ids to remove."),
    }),
    describe: a => (a.list ? `Change mailing list ${a.list}: add ${a.add?.length || 0}, remove ${a.remove?.length || 0}` : `Create mailing list “${a.name}”`),
    async run(a) {
      let id;
      if (a.list) {
        id = (await findList(a.list)).id;
      } else {
        if (!a.name) throw new Error("Give a name for the new list.");
        id = await messenger.mailingLists.create((await writableBook(a.addressBook)).id, { name: a.name });
      }
      for (const c of a.add || []) await messenger.mailingLists.addMember(id, c);
      for (const c of a.remove || []) await messenger.mailingLists.removeMember(id, c);
      return { content: "Done." };
    },
  },

  // ----- calendar
  {
    name: "list_calendars",
    risk: "read",
    description: "List calendars and whether they take events or tasks.",
    parameters: obj({}),
    run: async () => ({ content: json(await messenger.aiCalendar.listCalendars()) }),
  },
  {
    name: "list_events",
    risk: "read",
    description: "List calendar events between two times (ISO 8601, e.g. 2026-11-09 or 2026-11-09T14:00). Defaults to the next 7 days. Returns ids for update/delete.",
    parameters: obj({ from: str(), to: str(), calendar: str("Calendar name, optional."), text: str("Only events whose title, place or notes contain this.") }),
    async run(a) {
      const from = a.from || new Date().toISOString().slice(0, 10);
      let to = a.to;
      if (!to) {
        const d = new Date(from);
        d.setDate(d.getDate() + 7);
        to = d.toISOString().slice(0, 10);
      }
      let items = await messenger.aiCalendar.queryItems({ type: "event", rangeStart: from, rangeEnd: to, calendarId: a.calendar || undefined, limit: 300 });
      if (a.text) {
        const s = a.text.toLowerCase();
        items = items.filter(i => [i.title, i.location, i.description].some(v => v?.toLowerCase().includes(s)));
      }
      return { content: items.length ? json(items) : `No events between ${from} and ${to}.` };
    },
  },
  {
    name: "list_tasks",
    risk: "read",
    description: "List tasks (to-dos) with ids.",
    parameters: obj({ includeCompleted: bool() }),
    async run(a) {
      const items = await messenger.aiCalendar.queryItems({ type: "task", includeCompleted: !!a.includeCompleted, limit: 300 });
      return { content: items.length ? json(items) : "No tasks." };
    },
  },
  {
    name: "create_event",
    risk: "change",
    description: "Add an event. Times in ISO 8601 local time (2026-11-09T14:00); for all-day events give a date (2026-11-09) and allDay true.",
    parameters: obj({ title: str(), start: str(), end: str(), allDay: bool(), location: str(), description: str(), calendar: str() }, ["title", "start"]),
    describe: a => `Add event “${a.title}” on ${a.start}${a.end ? ` – ${a.end}` : ""}${a.location ? ` at ${a.location}` : ""}`,
    async run(a) {
      const r = await messenger.aiCalendar.createEvent({
        title: a.title,
        start: a.start,
        end: a.end || undefined,
        allDay: !!a.allDay,
        location: a.location || undefined,
        description: a.description || undefined,
        calendarId: a.calendar || undefined,
      });
      return { content: `Added to ${r.calendarName} (id ${r.id}).${r.confirmed === false ? UNCONFIRMED : ""}` };
    },
  },
  {
    name: "create_task",
    risk: "change",
    description: "Add a task (to-do), optionally with a due date/time in ISO 8601.",
    parameters: obj({ title: str(), due: str(), description: str(), calendar: str() }, ["title"]),
    describe: a => `Add task “${a.title}”${a.due ? `, due ${a.due}` : ""}`,
    async run(a) {
      const r = await messenger.aiCalendar.createTask({ title: a.title, due: a.due || undefined, description: a.description || undefined, calendarId: a.calendar || undefined });
      return { content: `Added to ${r.calendarName} (id ${r.id}).${r.confirmed === false ? UNCONFIRMED : ""}` };
    },
  },
  {
    name: "update_calendar_item",
    risk: "change",
    description: "Change an event or task by id (from list_events/list_tasks): title, times, place, notes, or completed for tasks. Changing a recurring event changes the whole series.",
    parameters: obj({
      id: str(),
      calendar: str(),
      title: str(),
      start: str(),
      end: str(),
      allDay: bool(),
      due: str(),
      location: str(),
      description: str(),
      completed: bool(),
    }, ["id"]),
    async describe(a) {
      let title = a.id;
      try {
        title = `“${(await messenger.aiCalendar.getItem(a.id, a.calendar || undefined)).title}”`;
      } catch (e) {}
      const fields = Object.entries(a).filter(([k]) => !["id", "calendar"].includes(k)).map(([k, v]) => `${k} → ${v}`);
      return `Change ${title}: ${fields.join(", ")}`;
    },
    async run(a) {
      const { calendar, ...rest } = a;
      const r = await messenger.aiCalendar.updateItem({ ...rest, calendarId: calendar || undefined });
      return { content: `Updated: ${json(r)}${r.confirmed === false ? UNCONFIRMED : ""}` };
    },
  },
  {
    name: "delete_calendar_item",
    risk: "confirm",
    description: "Delete an event or task by id. The user is always asked first. Deleting a recurring event deletes the whole series.",
    parameters: obj({ id: str(), calendar: str() }, ["id"]),
    async describe(a) {
      try {
        const i = await messenger.aiCalendar.getItem(a.id, a.calendar || undefined);
        return `Delete ${i.kind} “${i.title}”${i.start ? ` on ${i.start}` : ""}${i.recurring ? " (the whole series)" : ""}`;
      } catch (e) {
        return `Delete calendar item ${a.id}`;
      }
    },
    confirmLabel: () => "Delete",
    async run(a) {
      const r = await messenger.aiCalendar.deleteItem(a.id, a.calendar || undefined);
      return { content: `Deleted “${r.title}” from ${r.calendarName}.${r.confirmed === false ? UNCONFIRMED : ""}` };
    },
  },

  // ----- Thunderbird window
  {
    name: "open_message",
    risk: "ui",
    description: "Show a message to the user in a new tab or window.",
    parameters: obj({ id: int(), where: { type: "string", enum: ["tab", "window"] } }, ["id"]),
    async run(a) {
      await messenger.messageDisplay.open({ messageId: Number(a.id), location: a.where || "tab", active: true });
      return { content: "Opened." };
    },
  },
  {
    name: "show_folder",
    risk: "ui",
    description: "Show a folder in the user's mail tab.",
    parameters: obj({ folder: str() }, ["folder"]),
    async run(a) {
      const f = await folderOrThrow(a.folder);
      const [tab] = await messenger.mailTabs.query({ active: true, lastFocusedWindow: true });
      const target = tab ?? (await messenger.mailTabs.query({}))[0];
      if (!target) throw new Error("No mail tab is open.");
      await messenger.mailTabs.update(target.id, { displayedFolderId: f.id });
      return { content: `Showing ${f.path}.` };
    },
  },
  {
    name: "open_address_book",
    risk: "ui",
    description: "Open Thunderbird's address book.",
    parameters: obj({}),
    async run() {
      await messenger.addressBooks.openUI();
      return { content: "Opened." };
    },
  },

  // ----- JMAP (thunderbird-jmap build)
  {
    name: "jmap_accounts",
    risk: "read",
    description:
      "List the JMAP accounts: their capabilities (mail, submission, vacationresponse, sieve, quota, contacts, calendars, filenode, principals, …), JMAP account ids and limits. Use before jmap_request.",
    parameters: obj({}),
    async run() {
      return { content: json(await messenger.aiJmap.listAccounts()) };
    },
  },
  {
    name: "jmap_request",
    timeout: 90000,
    risk: jmapRisk,
    description:
      "Call JMAP methods directly on a JMAP account (RFC 8620/8621 and extensions), for anything the other tools can't do: vacation/out-of-office (VacationResponse/get|set), Sieve filter scripts (SieveScript/*), quotas (Quota/get), identities (Identity/*), masked or shared mailboxes, files (FileNode/*), principals and free/busy, JMAP contacts and calendars, thread and email details. Calls run in order in one request; refer to earlier results with ResultReference ('#ids' + resultOf). Reads run directly; changes follow the user's action setting; EmailSubmission/set (sending) and any destroy always need the user's click.",
    parameters: obj({
      account: str("JMAP account name, email or server key from jmap_accounts; first JMAP account if omitted."),
      calls: {
        type: "array",
        description: "JMAP method calls, e.g. [{\"name\":\"VacationResponse/get\",\"args\":{\"accountId\":\"…\",\"ids\":null}}]. accountId is required in args for most methods.",
        items: obj({ name: str("Method, e.g. Mailbox/get"), args: { type: "object" }, callId: str() }, ["name"]),
      },
      using: strList("Extra capability URNs (usually added automatically)."),
    }, ["calls"]),
    describe: a => describeJmap(a),
    details: a => cap(json(a.calls), 4000),
    confirmLabel: a => ((a.calls || []).some(c => c.name == "EmailSubmission/set") ? "Send" : "Do it"),
    async run(a) {
      const r = await messenger.aiJmap.request(a.account || "", a.calls, a.using || undefined);
      return { content: cap(json(r)) };
    },
  },
  {
    name: "jmap_download",
    risk: "read",
    description: "Download a JMAP blob (e.g. a Sieve script, a file node, an attachment) as text.",
    parameters: obj({ account: str(), blobId: str(), accountId: str("JMAP account id."), type: str("MIME type, e.g. application/sieve.") }, ["blobId"]),
    async run(a) {
      const r = await messenger.aiJmap.downloadText(a.account || "", a.blobId, { accountId: a.accountId || undefined, type: a.type || undefined });
      return { content: cap(json(r)) };
    },
  },
  {
    name: "jmap_upload",
    timeout: 90000,
    risk: "change",
    description: "Upload text as a JMAP blob (e.g. a new Sieve script or file) and get its blobId for a following jmap_request.",
    parameters: obj({ account: str(), text: str(), type: str("MIME type, e.g. application/sieve."), accountId: str() }, ["text"]),
    describe: a => `Upload ${a.text.length} characters (${a.type || "text/plain"}) to the JMAP server`,
    details: a => cap(a.text, 4000),
    async run(a) {
      return { content: json(await messenger.aiJmap.uploadText(a.account || "", a.text, a.type || undefined, a.accountId || undefined)) };
    },
  },
];

const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));
const riskOf = (tool, args) => (typeof tool.risk == "function" ? tool.risk(args || {}) : tool.risk);
const isLookup = t => typeof t.risk == "function" || t.risk == "read" || t.risk == "ui";

/** Tool definitions for the model, according to the settings. */
export function toolsFor(settings) {
  const actions = settings.actions && settings.actions != "off";
  return TOOLS.filter(t => (isLookup(t) ? settings.lookups !== false || actions : actions)).map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export function isAction(name, args) {
  const t = BY_NAME.get(name);
  return !!t && ["change", "confirm"].includes(riskOf(t, args));
}

/**
 * Runs a tool call. `ctx.approve(description, { always, name, details,
 * confirmLabel })` resolves to true when the user (or "Act on its own") allows it.
 */
export async function runTool(call, ctx) {
  const a = call.args || {};
  const { settings } = ctx;
  const tool = BY_NAME.get(call.name);
  if (!tool) {
    return { content: `Unknown tool ${call.name}.`, isError: true };
  }
  const risk = riskOf(tool, a);

  if (risk == "change" || risk == "confirm") {
    if (!settings.actions || settings.actions == "off") {
      return { content: "Actions are switched off in the settings; tell the user what you would do instead.", isError: true };
    }
    const description = tool.describe ? await tool.describe(a) : `${call.name} ${json(a).slice(0, 300)}`;
    const ok = await ctx.approve(description, {
      always: risk == "confirm" || settings.actions != "auto",
      name: call.name,
      details: tool.details ? tool.details(a) : undefined,
      confirmLabel: tool.confirmLabel ? tool.confirmLabel(a) : undefined,
      danger: risk == "confirm",
    });
    if (!ok) {
      return { content: "The user skipped this action. Don't do it again unless asked." };
    }
  } else if (settings.lookups === false && risk == "read") {
    return { content: "Looking things up is switched off in the settings.", isError: true };
  }

  return runWithLimit(tool, risk, tool.run(a, ctx), ctx.signal);
}

// Some Thunderbird calls apply the change but never report back (seen with
// moves on JMAP folders); the panel must not wait forever. Stop also works.
const LIMIT_MS = { read: 90000, ui: 20000, change: 20000, confirm: 30000 };

function runWithLimit(tool, risk, promise, signal) {
  const ms = tool.timeout ?? LIMIT_MS[risk] ?? 60000;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Stopped", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      console.warn(`AI assistant: ${tool.name} did not finish within ${ms / 1000} s`);
      resolve(
        risk == "read" || risk == "ui"
          ? { content: `${tool.name} got no answer from Thunderbird within ${ms / 1000} seconds.`, isError: true }
          : {
              content: `Thunderbird started this but didn't confirm it within ${ms / 1000} seconds. It has usually been done anyway: tell the user briefly to check, and don't repeat it.`,
              isError: true,
            }
      );
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
    promise.then(
      r => {
        cleanup();
        resolve(r);
      },
      e => {
        cleanup();
        reject(e);
      }
    );
  });
}
