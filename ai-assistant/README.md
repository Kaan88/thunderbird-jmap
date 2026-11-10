# AI Assistant for Thunderbird

An assistant that sits next to the message you are reading. Ask about the
message, get help writing, look things up in your mail, calendar and
contacts, and let it do the work: organize mail and folders, tags, contacts
and mailing lists, events and tasks, write, save and send mail, and change
JMAP server settings (out-of-office, Sieve filters, identities, ...). Sending
mail and deleting anything always shows you exactly what will happen and waits
for your click.

It works with:

- **any OpenAI-compatible service**: OpenAI, Ollama, LM Studio, OpenRouter,
  vLLM and others that speak the Chat Completions API;
- **Anthropic** (Claude), directly or through a gateway that speaks the
  Messages API;
- **Claude on this computer**: the Claude Code app you already have, with its
  own login (no API key), and any of its models (Fable 5.1, Opus 5.5,
  Sonnet 5.5, Haiku 5.5, ...). See *Claude on this computer* below.

Nothing is sent to a service until you ask for something.

Built for the `thunderbird-jmap` build (Thunderbird 162) and works on any
Thunderbird from 128 on that allows experiment add-ons (see *Requirements*).

## Features

**Next to the message** (button *AI assistant* in the message header, or
Ctrl+Shift+Y)

- Summarize, reply ideas, draft a reply, list what you have to do, explain,
  translate.
- Ask your own questions about the message. Follow-up questions keep the
  conversation.
- Highlight a passage in the message and ask about just that part, or use the
  right-click menu *AI assistant â†’ Ask about this / Explain this / Translate
  this*.
- Drafted replies come as a card with *Open as reply*, *Reply all*, *New
  message* and *Copy*. Opening puts the text in the composer above the quote;
  you review and send it yourself.
- The panel stays open as you move between messages and remembers its width.
  Switch service in its header; start over with the new-chat button.

**Looking things up** (on by default, can be turned off)

The assistant can search your mail, read a message, list folders, search
contacts and list calendar events and tasks when a question needs it
(â€œWhat's on my calendar this week?â€, â€œFind the invoice from Acmeâ€, â€œMail
waiting for an answerâ€). The panel shows each lookup it made.

**Actions** (setting *Actions*)

- *Off*: the assistant only answers.
- *Ask first* (default): every action shows a card with *Do it* / *Skip*.
- *Automatic*: actions run without asking, except sending mail and deleting
  anything, which always ask.

The assistant has 43 tools and can chain several in one answer (e.g. "make a
folder Projects and move all mail from Acme there").

| Area | Look up | Do |
|---|---|---|
| Mail | search (text, sender, tag, attachment, dates, folder, account), list a folder, read a message (also all headers or the raw source), read text attachments, list accounts/identities and tags | archive, move, copy, mark read/starred/junk, add/remove tags, create tags, delete (Trash or permanently; always asks) |
| Folders | list with counts | create, rename, move, mark all read, delete (always asks) |
| Writing | | open a new message/reply/forward in the composer, save a draft, send (always asks and shows the full message) |
| Contacts | address books, search, full vCard, mailing lists | add, update, delete (always asks), create lists, add/remove members |
| Calendar | calendars, events, tasks | add events and tasks, change them (times, place, notes, done), delete (always asks) |
| Thunderbird | | open a message, show a folder, open the address book |
| JMAP | accounts and capabilities, any `.../get`, `.../query`, `.../changes` call, blob download | any JMAP method (`VacationResponse/set`, `SieveScript/set`, `Identity/set`, `Mailbox/set`, `FileNode/*`, ...), blob upload; `EmailSubmission/set` and any `destroy` always ask |

On purpose there is no tool that runs arbitrary code inside Thunderbird: a
message could try to talk the model into using it, and that would hand your
whole computer to whoever wrote the message.

**While writing** (button *AI* in the composer toolbar, or right-click in the
message text â†’ *AI writing help*)

- Write a draft from a short description.
- Rewrite: improve, fix spelling, shorter, longer.
- Change the tone (more formal, friendlier, more direct) or say in your own
  words how to change it.
- Translate.

It works on your own text only (not the quoted message or signature), or on
the selection if you selected something. You see the result first and choose
*Replace*, *Copy* or *Try again*. Replacing is a normal edit, so Ctrl+Z undoes
it.

## Settings

Open them from the gear in the panel, or *Add-ons and Themes â†’ AI Assistant â†’
Options*.

| Setting | Notes |
|---|---|
| OpenAI-compatible: API address | e.g. `https://api.openai.com/v1`, or `http://localhost:11434/v1` for Ollama |
| OpenAI-compatible: API key | Optional; Ollama and LM Studio need none |
| OpenAI-compatible: model | e.g. `gpt-5-mini`, `llama3.2` |
| Anthropic: API address | Default `https://api.anthropic.com/v1` |
| Anthropic: API key | Required |
| Anthropic: model | Default `claude-haiku-5-5`; e.g. `claude-sonnet-5-5`, `claude-opus-5-5` |
| Claude on this computer | On/off, default model (`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `default`, or any name Claude Code accepts), optional path to `claude.exe` |
| Default service | Used when both are set up; you can switch in the panel |
| Instructions for the assistant | Added to every request: your name, sign-off, languages, background, things never to do. No length limit (tested with 40,000 characters); a character count is shown |
| Translate to | Target language for the translate buttons |
| Let the assistant look things up | Mail, calendar and contact lookups |
| What the assistant may do | Only answer / Ask me first / Act on its own |
| Saved prompts | One per line, `Name: prompt`; they appear in the panel's Actions menu |

*Test connection* / *Test* sends one tiny request (â€œReply with the single word OK.â€).

The panel's service menu lists every model of every service you set up, so
you can switch model per conversation:

- **Anthropic**: the built-in list (Opus 5.5, Sonnet 5.5, Haiku 5.5,
  Fable 5.1), or the models your key can use, after *Get the list from
  Anthropic* (Models API).
- **Claude on this computer**: Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 and
  Claude Code's own default.
- Untick models under *Models in the panel's menu* to hide them. The default
  model of a service always stays.

Next to it, the **effort** menu (Auto, Low, Medium, High, Max) sets how long
Claude may think. It is sent as `output_config.effort` to the Anthropic API
and as `--effort` to Claude Code, only for models that take it (the Claude 5
family, Opus 4.6+ and Sonnet 4.6; not Haiku 4.5), and dropped again if a
model or gateway rejects it. The default is set under *Assistant â†’ Effort*.

## Claude on this computer

This uses the Claude Code command-line app (`claude`) that is already
installed and logged in on your computer, through a small helper program
(a native messaging host) in `native/`:

1. Install Node.js and Claude Code, and log in to Claude Code once.
2. On Linux run `native/install.sh` (it puts the helper in `~/.local/share/thunderbird-ai-assistant/native`
   and registers it under `~/.mozilla/native-messaging-hosts`; `native/uninstall.sh` removes it). On Windows run
   `powershell -ExecutionPolicy Bypass -File native\install.ps1`. It
   copies the helper to `%LOCALAPPDATA%\thunderbird-ai-assistant\native`,
   writes its manifest and registers it under
   `HKCU\Software\Mozilla\NativeMessagingHosts\ai_assistant_claude` (the key
   Thunderbird reads). `native\uninstall.ps1` removes it again.
3. Restart Thunderbird, tick *Use Claude on this computer* in the settings and
   press *Test*.

How it runs: for each question the helper starts
`claude -p --output-format stream-json` with your chosen model and the
assistant's system prompt (from a file, so it can be very long). Claude Code's
own tools are switched off (`--tools ""`), none of your Claude Code settings,
hooks, plugins or CLAUDE.md files are loaded (`--setting-sources ""`, an empty
temporary working folder), and only the assistant's tools are offered, through
a small MCP bridge (`native/mcp-bridge.js`). Every tool call comes back to the
add-on and goes through the same approval cards. Follow-up questions resume
the same Claude Code session. Usage counts against your Claude plan like any
other Claude Code use. If Node.js moves, run `install.ps1` again.

When you save, Thunderbird asks once for permission to reach each service's
address. The add-on only asks for the addresses you enter.

## Privacy

- Nothing goes to a service until you click or type something in the panel or
  the writing popup. Opening a message sends nothing.
- What is sent: the open message (or the text you are writing), your
  question, your standing instructions, and the results of lookups the
  assistant makes for that question.
- With *Claude on this computer*, the text goes to Claude through your Claude
  Code login, under your Claude plan's terms.
- API keys are stored only in the add-on's local storage in your Thunderbird
  profile (`browser.storage.local`). They are never written into the add-on or
  sent anywhere except to the service they belong to.
- Mail content is passed to the model as data, with an instruction not to
  follow instructions found inside messages. Actions still go through the
  approval cards, so a message that tries to trick the model cannot act on its
  own unless you chose *Automatic* (and even then cannot send mail or delete
  anything without your click).

## Requirements

The add-on uses three small experiment APIs (in `experiments/`):

- `aiPanel` docks the panel next to the message inside the reader, and reads
  which message is shown.
- `aiCalendar` reads, adds, changes and deletes events and tasks
  (Thunderbird has no built-in calendar API for add-ons yet).
- `aiJmap` lists the JMAP accounts of the `thunderbird-jmap` build and runs
  JMAP method calls on Thunderbird's own JMAP session for that account (no
  extra login). On other builds the JMAP tools just say there is no JMAP
  support.

Experiment add-ons need an unsigned-add-on-friendly build: Thunderbird Daily
or Beta, or a build with `extensions.experiments.enabled` set to `true` (the
`thunderbird-jmap` build has it). If docking fails, the panel opens in its own
window instead.

Thunderbird can only compose when an account with an email address exists;
otherwise *Open as reply* shows a message instead.

## Install

1. Build or download `ai-assistant-<version>.xpi`.
2. In Thunderbird: *Add-ons and Themes â†’ gear â†’ Install Add-on From Fileâ€¦*
   and pick the `.xpi`. Unsigned add-ons need
   `xpinstall.signatures.required = false` (Config Editor).
3. The settings page opens on first install. Fill in at least one service.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

This writes `dist\ai-assistant-<version>.xpi` (a zip with `manifest.json` at
the root). There is no build step beyond zipping: the code is plain ES
modules.

## Layout

```
manifest.json         MV3 manifest
background.js         buttons, shortcut, menus, content-script setup
lib/settings.js       settings and host permissions
lib/providers.js      streaming clients for OpenAI-compatible and Anthropic APIs, tool loop
lib/claude-local.js   "Claude on this computer" client (native messaging)
lib/tools.js          the tool registry: every tool with its risk level and code
lib/prompts.js        system prompt, quick actions, rewrite prompts
lib/mail.js           message text, headers, vCards, folders
lib/markdown.js       safe Markdown renderer (DOM only, no innerHTML)
panel/                the side panel
compose/              the writing-help popup
options/              the settings page
scripts/              content scripts for the message (selection) and composer (edits)
experiments/          aiPanel, aiCalendar and aiJmap experiment APIs
native/               helper for Claude on this computer (host, MCP bridge, install, uninstall, test)
```

## Known issues

- In the `thunderbird-jmap` build of 2026-11-08, `msgHdrView.js` throws when
  getting the system alerts service while a message loads, so
  `messageDisplay.getDisplayedMessages()` never returns and
  `onMessageDisplayed` never fires. The add-on works around this by reading
  the shown message through its `aiPanel` experiment and by listening to
  selection changes.
- In that build, `compose.beginReply()` crashes Thunderbird when no account
  has an identity. The add-on checks for an identity first.
- In that build, a JMAP account without a saved password is never asked for
  one: it connects anonymously, gets a session without accounts, and every
  JMAP call (and sending through it) then fails with "No JMAP account
  supports ...". Accounts set up through the account wizard (password saved)
  are not affected. The JMAP tools pass the server's error on, with a hint.
- In that build, `compose.sendMessage()` resolves (with `headerMessageId:
  null`) instead of failing when sending fails; the add-on checks for that
  and tells you the message was not sent.
- If Thunderbird applies an action but never reports back (suspected for moves/archives on JMAP folders), the panel stops waiting after 20 seconds (sending: 3 minutes), says the action wasn't confirmed, and carries on. A model stream that sends nothing for 3 minutes ends with an error. Stop always works.
- Answers depend on the model. Small local models may ignore tools or the
  email draft format; the add-on retries without tools for models that
  reject them.
