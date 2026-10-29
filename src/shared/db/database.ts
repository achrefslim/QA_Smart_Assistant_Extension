/**
 * src/shared/db/database.ts
 *
 * IndexedDB wrapper for QA session storage.
 *
 * Why IndexedDB and not chrome.storage?
 * Video blobs can easily be 50-200 MB. chrome.storage has a 10 MB quota
 * even with unlimitedStorage. IndexedDB stores Blob values natively and
 * the unlimitedStorage permission keeps Chrome from evicting them.
 */

import { Config } from '../config/env';
import type { QASession } from '../types';

const { name, version, store, maxSessions } = Config.db;

// ─── Open / Upgrade Database ─────────────────────────────────────────────────

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(store)) {
        db.createObjectStore(store, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function getAllRaw(db: IDBDatabase): Promise<QASession[]> {
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).getAll();
    request.onsuccess = () => resolve((request.result as QASession[]) || []);
    request.onerror   = () => reject(request.error);
  });
}

/**
 * Remove the oldest sessions if we exceed the maximum allowed.
 * This keeps storage from growing indefinitely.
 */
async function pruneOldSessions(db: IDBDatabase): Promise<void> {
  const all = await getAllRaw(db);
  if (all.length <= maxSessions) return;

  const sorted   = all.sort((a, b) => a.timestamp - b.timestamp);
  const toDelete = sorted.slice(0, sorted.length - maxSessions);

  await new Promise<void>((resolve, reject) => {
    const tx    = db.transaction(store, 'readwrite');
    const store_ = tx.objectStore(store);
    toDelete.forEach(session => store_.delete(session.id));
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Save a new session. Automatically prunes old sessions afterward. */
export async function saveSession(session: QASession): Promise<void> {
  const db = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(session);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });

  await pruneOldSessions(db);
  db.close();
}

/** Return all sessions sorted newest first. */
export async function getAllSessions(): Promise<QASession[]> {
  const db   = await openDatabase();
  const all  = await getAllRaw(db);
  db.close();
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

/** Return a single session by id, or null if not found. */
export async function getSession(id: string): Promise<QASession | null> {
  const db = await openDatabase();

  const record = await new Promise<QASession | null>((resolve, reject) => {
    const tx      = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).get(id);
    request.onsuccess = () => resolve((request.result as QASession) || null);
    request.onerror   = () => reject(request.error);
  });

  db.close();
  return record;
}

/** Permanently delete a session by id. */
export async function deleteSession(id: string): Promise<void> {
  const db = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });

  db.close();
}

/**
 * Update specific fields of an existing session without touching the video blob.
 * Used by the review page to save rules, annotations, and transcript after Groq.
 */
export async function updateSessionFields(
  id    : string,
  fields: Partial<Omit<QASession, 'id' | 'videoBlob'>>
): Promise<void> {
  const db = await openDatabase();

  const existing = await new Promise<QASession | null>((resolve, reject) => {
    const tx      = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).get(id);
    request.onsuccess = () => resolve((request.result as QASession) || null);
    request.onerror   = () => reject(request.error);
  });

  if (!existing) {
    db.close();
    return;
  }

  const updated = { ...existing, ...fields };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(updated);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });

  db.close();
}
