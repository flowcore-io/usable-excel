/**
 * history-store — local chat-history persistence for the Usable Chat embed.
 *
 * HOST-AGNOSTIC by design: NO Office.js / Excel imports. It stores plain JSON
 * (`ExportedMessage` from the embed contract) scoped by `userId` (the JWT
 * `sub`, supplied by the caller — this file never reads auth itself). The
 * planned `@usable/office-embed` package (ticket `eb582b42`) lifts this file.
 *
 * Idempotency: every write is a `put` keyed on a stable id (`message.id` for
 * messages, `conversationId` for conversations). The Office/WKWebView + legacy
 * React environment can deliver the same lifecycle event twice (`af132e37`);
 * put-by-id means a duplicate delivery overwrites the same row — never a dupe.
 *
 * Data model (PRD bf6574a3 §7):
 * - conversations { id, userId, title, createdAt, updatedAt }   index: by-user
 * - messages      { id, conversationId, userId, kind, message, createdAt }  index: by-conversation
 * - meta          { userId, lastActiveConversationId }
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ExportedMessage } from "./embed-sdk";

export interface ConversationRecord {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  /** == ExportedMessage.id — the idempotency key. */
  id: string;
  conversationId: string;
  userId: string;
  kind: "user" | "assistant";
  message: ExportedMessage;
  createdAt: string;
}

interface MetaRecord {
  userId: string;
  lastActiveConversationId: string | null;
}

interface ChatHistoryDB extends DBSchema {
  conversations: {
    key: string;
    value: ConversationRecord;
    indexes: { "by-user": string };
  };
  messages: {
    key: string;
    value: MessageRecord;
    indexes: { "by-conversation": string };
  };
  meta: {
    key: string;
    value: MetaRecord;
  };
}

const DB_NAME = "usable-excel-chat-history";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<ChatHistoryDB>> | null = null;

function getDB(): Promise<IDBPDatabase<ChatHistoryDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ChatHistoryDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("conversations")) {
          const conv = db.createObjectStore("conversations", { keyPath: "id" });
          conv.createIndex("by-user", "userId");
        }
        if (!db.objectStoreNames.contains("messages")) {
          const msg = db.createObjectStore("messages", { keyPath: "id" });
          msg.createIndex("by-conversation", "conversationId");
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "userId" });
        }
      },
    });
  }
  return dbPromise;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Placeholder title for a conversation the embed created without naming. */
const DEFAULT_CONVERSATION_TITLE = "Embed Session";

/** A conversation still on the placeholder (or empty) title — eligible for a
 *  derived display title from its first user message. */
function isPlaceholderTitle(title: string): boolean {
  return !title || title === DEFAULT_CONVERSATION_TITLE;
}

/** Build a short, single-line title from a user message's content. */
function deriveTitleFromContent(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
}

// ---------------------------------------------------------------------------
// Writes (all idempotent via put-by-id)
// ---------------------------------------------------------------------------

export interface UpsertConversationInput {
  id: string;
  userId: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Insert or update a conversation. Preserves the original createdAt/title when
 *  the row already exists and the new payload omits them. */
export async function upsertConversation(input: UpsertConversationInput): Promise<void> {
  const db = await getDB();
  const existing = await db.get("conversations", input.id);
  const record: ConversationRecord = {
    id: input.id,
    userId: input.userId,
    title: input.title ?? existing?.title ?? DEFAULT_CONVERSATION_TITLE,
    createdAt: existing?.createdAt ?? input.createdAt ?? nowIso(),
    updatedAt: input.updatedAt ?? nowIso(),
  };
  await db.put("conversations", record);
}

export interface AppendMessageInput {
  userId: string;
  conversationId: string;
  kind: "user" | "assistant";
  message: ExportedMessage;
}

/**
 * Persist a message (idempotent on message.id) and bump the parent
 * conversation's updatedAt. Creates a stub conversation if the message arrives
 * before its CONVERSATION_CREATED event (ordering is not guaranteed).
 *
 * @returns `{ inserted }` — false when the same message.id already existed
 *          (i.e. a deduped duplicate delivery), useful for live verification.
 */
export async function appendMessage(input: AppendMessageInput): Promise<{ inserted: boolean }> {
  const db = await getDB();
  const createdAt = input.message.createdAt ?? nowIso();

  const tx = db.transaction(["messages", "conversations"], "readwrite");
  const messages = tx.objectStore("messages");
  const conversations = tx.objectStore("conversations");

  const existing = await messages.get(input.message.id);
  const inserted = existing === undefined;

  const record: MessageRecord = {
    id: input.message.id,
    conversationId: input.conversationId,
    userId: input.userId,
    kind: input.kind,
    message: input.message,
    createdAt,
  };
  await messages.put(record);

  const conv = await conversations.get(input.conversationId);
  const bumped = nowIso();
  if (conv) {
    conv.updatedAt = bumped;
    await conversations.put(conv);
  } else {
    // Stub: message arrived before CONVERSATION_CREATED (or it was missed).
    await conversations.put({
      id: input.conversationId,
      userId: input.userId,
      title: "Embed Session",
      createdAt,
      updatedAt: bumped,
    });
  }

  await tx.done;
  return { inserted };
}

/** Rename a conversation (no-op if it doesn't exist yet). */
export async function renameConversation(
  _userId: string,
  conversationId: string,
  title: string
): Promise<void> {
  const db = await getDB();
  const conv = await db.get("conversations", conversationId);
  if (conv) {
    conv.title = title;
    conv.updatedAt = nowIso();
    await db.put("conversations", conv);
  }
}

/** Record which conversation the user last had active (for restore-on-load, Phase 3). */
export async function setLastActive(userId: string, conversationId: string | null): Promise<void> {
  const db = await getDB();
  await db.put("meta", { userId, lastActiveConversationId: conversationId });
}

/**
 * Delete a conversation and every message that belongs to it, in a single
 * transaction (Phase 4). If the deleted conversation was the restore pointer
 * (`meta.lastActiveConversationId`), clear it so the next reload starts fresh
 * instead of trying to restore a conversation that no longer exists.
 */
export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["conversations", "messages", "meta"], "readwrite");

  // Remove all messages for this conversation via the by-conversation index.
  let cursor = await tx.objectStore("messages").index("by-conversation").openCursor(conversationId);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }

  await tx.objectStore("conversations").delete(conversationId);

  // Drop the restore pointer if it referenced the conversation we just deleted.
  const meta = await tx.objectStore("meta").get(userId);
  if (meta && meta.lastActiveConversationId === conversationId) {
    await tx.objectStore("meta").put({ userId, lastActiveConversationId: null });
  }

  await tx.done;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getLastActive(userId: string): Promise<string | null> {
  const db = await getDB();
  const meta = await db.get("meta", userId);
  return meta?.lastActiveConversationId ?? null;
}

export async function loadConversation(
  conversationId: string
): Promise<{ conversation: ConversationRecord | undefined; messages: MessageRecord[] }> {
  const db = await getDB();
  const conversation = await db.get("conversations", conversationId);
  const messages = await db.getAllFromIndex("messages", "by-conversation", conversationId);
  // Chronological order for restore.
  messages.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return { conversation, messages };
}

/**
 * All conversations for a user, newest activity first.
 *
 * Stateless embeds create conversations untitled, so any row still on the
 * placeholder title gets a readable display title derived from its first user
 * message (the embed never auto-titles them). This is display-only — the stored
 * title stays as-is until a real rename or an embed title-sync — so it also
 * backfills conversations captured before this behaviour existed.
 */
export async function listConversations(userId: string): Promise<ConversationRecord[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("conversations", "by-user", userId);
  all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  for (const conv of all) {
    if (!isPlaceholderTitle(conv.title)) continue;
    const messages = await db.getAllFromIndex("messages", "by-conversation", conv.id);
    messages.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const firstUser = messages.find((m) => m.kind === "user");
    const derived = deriveTitleFromContent(firstUser?.message.content);
    if (derived) conv.title = derived;
  }

  return all;
}

/** Row counts scoped to a user — live verification helper (no DevTools needed). */
export async function getCounts(userId: string): Promise<{ conversations: number; messages: number }> {
  const db = await getDB();
  const conversations = await db.getAllFromIndex("conversations", "by-user", userId);
  let messages = 0;
  for (const conv of conversations) {
    messages += await db.countFromIndex("messages", "by-conversation", conv.id);
  }
  return { conversations: conversations.length, messages };
}
