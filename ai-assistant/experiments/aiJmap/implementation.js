/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Direct JMAP access for the AI assistant: lists the JMAP accounts of the
// thunderbird-jmap build and runs JMAP method calls on their shared session
// (the same connection Thunderbird itself uses, so no extra login).

/* global ExtensionAPI */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionUtils.sys.mjs"
);
var { ExtensionError } = ExtensionUtils;
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

function registry() {
  try {
    return ChromeUtils.importESModule(
      "resource:///modules/jmap/JmapAccountRegistry.sys.mjs"
    ).JmapAccountRegistry;
  } catch (e) {
    throw new ExtensionError("This Thunderbird has no JMAP support.");
  }
}

function accountKeyFor(server) {
  try {
    return MailServices.accounts.findAccountForServer(server)?.key ?? null;
  } catch (e) {
    return null;
  }
}

function emailsFor(server) {
  try {
    const account = MailServices.accounts.findAccountForServer(server);
    return account ? account.identities.map(i => i.email).filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}

function findServer(spec) {
  const servers = registry().servers;
  if (!servers.length) {
    throw new ExtensionError("There is no JMAP account in Thunderbird.");
  }
  if (!spec) {
    return servers[0];
  }
  const s = String(spec).toLowerCase();
  const found = servers.find(
    server =>
      server.key.toLowerCase() == s ||
      accountKeyFor(server)?.toLowerCase() == s ||
      server.prettyName.toLowerCase() == s ||
      server.username.toLowerCase() == s ||
      emailsFor(server).some(e => e.toLowerCase() == s)
  );
  if (!found) {
    throw new ExtensionError(`No JMAP account matches "${spec}".`);
  }
  return found;
}

// Errors from chrome code reach the extension only as ExtensionError; anything
// else turns into "An unexpected error occurred".
function wrap(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof ExtensionError) {
        throw e;
      }
      console.error("AI assistant JMAP:", e);
      let msg = String(e?.message || e);
      if (e?.status == 401 || /401|unauthori[sz]ed|authenticat/i.test(msg)) {
        msg += " (The account isn't logged in: open it in Thunderbird once and enter the password, then try again.)";
      }
      throw new ExtensionError(msg);
    }
  };
}

// Results cross into the extension as plain JSON.
const plain = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

this.aiJmap = class extends ExtensionCommon.ExtensionAPI {
  getAPI() {
    return {
      aiJmap: {
        listAccounts: wrap(async () => {
          const reg = registry();
          const out = [];
          for (const server of reg.servers) {
            const entry = {
              server: server.key,
              accountId: accountKeyFor(server),
              name: server.prettyName,
              username: server.username,
              emails: emailsFor(server),
            };
            try {
              const client = await reg.getClient(server);
              const session = client.session || {};
              entry.capabilities = Object.keys(session.capabilities || {});
              entry.primaryAccounts = session.primaryAccounts || {};
              entry.jmapAccounts = Object.entries(session.accounts || {}).map(
                ([id, a]) => ({
                  id,
                  name: a.name,
                  isPersonal: a.isPersonal,
                  isReadOnly: a.isReadOnly,
                  capabilities: Object.keys(a.accountCapabilities || {}),
                })
              );
              const core = session.capabilities?.["urn:ietf:params:jmap:core"];
              if (core) {
                entry.limits = {
                  maxCallsInRequest: core.maxCallsInRequest,
                  maxObjectsInGet: core.maxObjectsInGet,
                  maxObjectsInSet: core.maxObjectsInSet,
                };
              }
            } catch (e) {
              entry.error = String(e?.message || e);
            }
            out.push(entry);
          }
          return out;
        }),

        request: wrap(async (account, calls, using) => {
          const reg = registry();
          const server = findServer(account);
          const client = await reg.getClient(server);
          const result = await client.request(
            calls.map(c => ({ name: c.name, args: c.args || {}, callId: c.callId || undefined })),
            { using: using || [], allowErrors: true }
          );
          return plain({
            server: server.key,
            responses: result.responses,
            createdIds: result.createdIds,
          });
        }),

        downloadText: wrap(async (account, blobId, options) => {
          const reg = registry();
          const client = await reg.getClient(findServer(account));
          const { blob, contentType } = await client.download(blobId, {
            accountId: options?.accountId || undefined,
            type: options?.type || undefined,
            name: options?.name || undefined,
          });
          const max = options?.maxChars || 60000;
          const text = await blob.text();
          return {
            contentType,
            size: blob.size,
            text: text.slice(0, max),
            truncated: text.length > max,
          };
        }),

        uploadText: wrap(async (account, text, type, accountId) => {
          const reg = registry();
          const client = await reg.getClient(findServer(account));
          return plain(
            await client.upload(text, type || "text/plain", {
              accountId: accountId || undefined,
            })
          );
        }),
      },
    };
  }
};
