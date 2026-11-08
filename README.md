# thunderbird-jmap

An experimental build of Thunderbird (comm-central, 162.0a1 "Daily") that adds native
[JMAP](https://jmap.io) support:

- **Mail** (RFC 8620/8621): folder sync, read/flag/tag/move/copy/delete, undo,
  Drafts and Sent, sending through `EmailSubmission`, server-side search, quota,
  filters and junk handling, offline queue, push via the JMAP event source.
- **Contacts** (RFC 9610) as a synced address book.
- **Calendars** (JMAP Calendars draft) as a calendar provider, with free/busy.
- **Files** (Stalwart `urn:ietf:params:jmap:filenode`): a FileLink provider, a Files tab,
  "Save to Files" for attachments and "Attach from Files" in compose.
- **Account setup**: the account wizard probes `/.well-known/jmap` and prefers JMAP
  when the server offers it. Vacation response, Sieve scripts and push settings live in
  Account Settings.

It is developed and tested against [Stalwart](https://stalw.art).

> This is an unofficial build, not a Mozilla product. It uses the unbranded
> "Daily" branding. Expect bugs; keep backups of your profile.

## Install (Windows x64)

1. Download `thunderbird-jmap-*-win64.zip` from the latest release.
2. Unzip it anywhere you can write to, for example `%LOCALAPPDATA%\thunderbird-jmap`.
3. Run `thunderbird.exe -P` to create or pick a profile. Don't share a profile with a
   stock Thunderbird install.

Updates: the build ships `distribution/policies.json`, which sets `AppUpdateURL` to this
repository's latest `update.xml`. Thunderbird's normal updater then installs new
releases. MARs are signed with this project's own key, which is built into the updater.
Updates from Mozilla are not accepted.

## Source

`patches/thunderbird-jmap.patch` applies on top of comm-central
`5ca7b8c98d1cdbed7c17e475d7b57a14804bb2f7`, inside a Firefox tree at
`b42441b06b` (mozilla-firefox/firefox). `patches/gecko-jmap.patch` applies to
the Firefox tree itself: Gecko only loads a fixed list of mail URL schemes in
the parent process, and the JMAP message scheme (`x-moz-jmap`) has to be on it
or messages never display. Build with
`ac_add_options --enable-project=comm/mail` and
`ac_add_options --enable-update-channel=jmap`.

To build an updater that accepts this project's MARs, replace
`toolkit/mozapps/update/updater/dep1.der` and `dep2.der` in the Firefox tree with
`signing/jmapmar.der`. That file is the public certificate; the signing key is not in this
repository.

Live tests (`mailnews/protocols/jmap/test/live`) run against a local Stalwart server.
They are skipped unless a JSON file with test accounts exists; see `test/live/head.js`.

The JMAP code lives in:

- `mailnews/protocols/jmap/`: protocol layer (JS) and folder/server classes (C++)
- `mail/components/accountcreation/modules/JmapDiscovery.sys.mjs`: setup discovery
- `mailnews/addrbook/modules/JmapDirectory.sys.mjs`, `JmapJSContact.sys.mjs`: contacts
- `calendar/providers/jmap/`: calendars
- `mail/components/jmapfiles/`: files

License: MPL 2.0, same as Thunderbird.
