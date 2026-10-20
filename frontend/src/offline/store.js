const DATABASE_NAME = 'ddin-field-offline';
const DATABASE_VERSION = 1;
const DRAFT_LIMIT = 50;

let databasePromise;

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('Offline storage is not available in this browser.'));
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('agentPacks')) db.createObjectStore('agentPacks', { keyPath: 'userId' });
      if (!db.objectStoreNames.contains('visitDrafts')) {
        const drafts = db.createObjectStore('visitDrafts', { keyPath: 'clientVisitId' });
        drafts.createIndex('userId', 'userId', { unique: false });
      }
      if (!db.objectStoreNames.contains('auth')) db.createObjectStore('auth', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open offline storage.'));
    request.onblocked = () => reject(new Error('Offline storage is blocked by another open app tab.'));
  });
  return databasePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Offline storage request failed.'));
  });
}

async function transactionStore(name, mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, mode);
    const store = transaction.objectStore(name);
    let result;
    try { result = action(store); }
    catch (error) { transaction.abort(); reject(error); return; }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('Offline storage transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Offline storage transaction was canceled.'));
  });
}

export async function saveAgentPack(pack) {
  if (!pack?.userId) throw new Error('The offline package has no user ID.');
  await transactionStore('agentPacks', 'readwrite', (store) => store.put({ ...pack, savedAt: new Date().toISOString() }));
  notifyQueueUpdate();
}

export async function getAgentPack(userId) {
  const db = await openDatabase();
  return requestResult(db.transaction('agentPacks', 'readonly').objectStore('agentPacks').get(userId));
}

export async function saveVisitDraft(draft, { scheduleSync = true } = {}) {
  if (!draft?.userId || !draft?.clientVisitId) throw new Error('The visit draft is missing its user or visit ID.');
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('visitDrafts', 'readwrite');
    const store = transaction.objectStore('visitDrafts');
    const existingRequest = store.count(draft.clientVisitId);
    const countRequest = store.index('userId').count(draft.userId);
    let existingChecked = false;
    let countChecked = false;
    let limitError = null;
    const putWhenChecked = () => {
      if (!existingChecked || !countChecked) return;
      if (!existingRequest.result && countRequest.result >= DRAFT_LIMIT) {
        limitError = new Error(`This device can keep up to ${DRAFT_LIMIT} unfinished or unsynced visits. Connect and sync before starting another.`);
        transaction.abort();
        return;
      }
      store.put({ ...draft, updatedAt: new Date().toISOString() });
    };
    existingRequest.onsuccess = () => { existingChecked = true; putWhenChecked(); };
    countRequest.onsuccess = () => { countChecked = true; putWhenChecked(); };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(limitError || transaction.error || new Error('Offline visit storage failed.'));
    transaction.onabort = () => reject(limitError || transaction.error || new Error('Offline visit storage was canceled.'));
  });
  notifyQueueUpdate();
  if (draft.completed && scheduleSync) registerBackgroundSync();
}

export async function getVisitDrafts(userId) {
  if (!userId) return [];
  const db = await openDatabase();
  const items = await requestResult(db.transaction('visitDrafts', 'readonly').objectStore('visitDrafts').index('userId').getAll(userId));
  return (items || []).sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
}

export async function getVisitDraft(clientVisitId) {
  const db = await openDatabase();
  return requestResult(db.transaction('visitDrafts', 'readonly').objectStore('visitDrafts').get(clientVisitId));
}

export async function deleteVisitDraft(clientVisitId) {
  await transactionStore('visitDrafts', 'readwrite', (store) => store.delete(clientVisitId));
  notifyQueueUpdate();
}

export async function saveAuthSession({ userId, accessToken, refreshToken }) {
  if (!userId || !accessToken) return;
  await transactionStore('auth', 'readwrite', (store) => store.put({ key: 'session', userId, accessToken, refreshToken: refreshToken || '' }));
}

export async function clearAuthSession() {
  await transactionStore('auth', 'readwrite', (store) => store.delete('session'));
}

export async function getAuthSession() {
  const db = await openDatabase();
  return requestResult(db.transaction('auth', 'readonly').objectStore('auth').get('session'));
}

export function notifyQueueUpdate() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('ddin-offline-queue-updated'));
}

export async function registerBackgroundSync() {
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration?.sync?.register) await registration.sync.register('ddin-visit-sync');
  } catch {
    // The app also syncs on reconnect, foreground, and the user's manual request.
  }
}
