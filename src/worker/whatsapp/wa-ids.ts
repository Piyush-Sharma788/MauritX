/**
 * WhatsApp Web identifiers, read defensively.
 *
 * whatsapp-web.js copies objects out of WhatsApp Web's own code. Newer WhatsApp
 * Web builds no longer expose the `_serialized` field on these copies (the
 * serialised form now sits under a minified key such as `$1`), so reading
 * `id._serialized` silently yields undefined. These helpers rebuild the stable
 * string from the parts WhatsApp has kept: `<fromMe>_<chat>_<id>` for messages
 * and `<user>@<server>` for chats and contacts.
 */

type Wid = string | { _serialized?: unknown; user?: unknown; server?: unknown } | null | undefined;

/** "919876543210@c.us", "123456789@lid" ... or null if unreadable. */
export function serializeWid(wid: Wid): string | null {
  if (!wid) return null;
  if (typeof wid === "string") return wid.includes("@") ? wid : null;
  if (typeof wid._serialized === "string" && wid._serialized) return wid._serialized;
  if (typeof wid.user === "string" && typeof wid.server === "string" && wid.user && wid.server) return `${wid.user}@${wid.server}`;
  return null;
}

interface MessageKey {
  _serialized?: unknown;
  fromMe?: unknown;
  remote?: Wid;
  id?: unknown;
  participant?: Wid;
}

/** The message's unique key, identical for the sent message and its later delivery acks. */
export function serializeMessageId(key: MessageKey | null | undefined): string | null {
  if (!key) return null;
  if (typeof key._serialized === "string" && key._serialized) return key._serialized;
  const remote = serializeWid(key.remote);
  if (typeof key.id !== "string" || !key.id || !remote) return null;
  const participant = serializeWid(key.participant);
  return `${key.fromMe === true ? "true" : "false"}_${remote}_${key.id}${participant ? `_${participant}` : ""}`;
}
