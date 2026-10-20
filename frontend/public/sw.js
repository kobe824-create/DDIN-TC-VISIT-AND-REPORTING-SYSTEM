const CACHE_NAME = 'ddin-field-shell-v3';
const DATABASE_NAME = 'ddin-field-offline';
const DATABASE_VERSION = 1;
const APP_SHELL = ['/', '/manifest.webmanifest', '/logo.png', '/icon-192.png', '/icon-512.png'];

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Offline storage could not be opened.'));
  });
}

function storeRequest(storeName, mode, action) {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    let request;
    try { request = action(transaction.objectStore(storeName)); }
    catch (error) { transaction.abort(); reject(error); return; }
    if (request) {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Offline storage request failed.'));
    } else {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Offline storage transaction failed.'));
    }
  }));
}

const getSession = () => storeRequest('auth', 'readonly', (store) => store.get('session'));
const saveSession = (session) => storeRequest('auth', 'readwrite', (store) => store.put(session));
const getDrafts = (userId) => storeRequest('visitDrafts', 'readonly', (store) => store.index('userId').getAll(userId));
const saveDraft = (draft) => storeRequest('visitDrafts', 'readwrite', (store) => store.put({ ...draft, updatedAt: new Date().toISOString() }));
const removeDraft = (clientVisitId) => storeRequest('visitDrafts', 'readwrite', (store) => store.delete(clientVisitId));

async function refreshAccessToken(session) {
  if (!session?.refreshToken) throw new Error('The saved session has expired. Sign in while connected to continue syncing.');
  const response = await fetch('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  if (!response.ok) throw new Error('The saved session could not be refreshed. Sign in while connected to continue syncing.');
  const result = await response.json();
  const updated = { ...session, accessToken: result.token };
  await saveSession(updated);
  return updated;
}

async function requestWithSession(path, options = {}, initialSession, retried = false) {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${initialSession.accessToken}`);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 && !retried) {
    const refreshed = await refreshAccessToken(initialSession);
    return requestWithSession(path, options, refreshed, true);
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try { const body = await response.json(); detail = body.error || body.message || detail; } catch { /* Keep the status message. */ }
    throw new Error(detail);
  }
  return response;
}

async function syncDraft(draft, session) {
  if (!draft.completed || !draft.reportPayload || !draft.photoBlob) return;
  let current = { ...draft };
  if (!current.serverVisitId) {
    const response = await requestWithSession('/api/v1/visits/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        visitId: current.clientVisitId,
        agentId: current.agentId,
        tcLatitude: current.tcLatitude,
        tcLongitude: current.tcLongitude,
        gpsAccuracyMeters: current.gpsAccuracyMeters,
        visitDate: current.visitDate,
        checkInTime: current.checkInTime,
        agentLocation: current.agentLocation || null,
      }]),
    }, session);
    const result = await response.json();
    const visit = result.syncedVisits?.find((item) => item.clientVisitId === current.clientVisitId);
    if (!visit?.id) throw new Error('The server did not confirm this visit check-in.');
    current.serverVisitId = visit.id;
    current.publicVisitId = visit.visitId;
    await saveDraft(current);
  }

  const detailResponse = await requestWithSession(`/api/v1/visits/${current.serverVisitId}`, {}, session);
  const visitDetail = await detailResponse.json();
  if (!visitDetail.photos?.length) {
    const form = new FormData();
    form.append('photo', current.photoBlob, current.photoName || `visit-${current.clientVisitId}.jpg`);
    await requestWithSession(`/api/v1/visits/${current.serverVisitId}/photo`, { method: 'PUT', body: form }, session);
  }
  if (!visitDetail.report) {
    await requestWithSession(`/api/v1/visits/${current.serverVisitId}/report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(current.reportPayload),
    }, session);
  }
  if (!['COMPLETED', 'FLAGGED'].includes(visitDetail.visitStatus)) {
    await requestWithSession(`/api/v1/visits/${current.serverVisitId}/check-out`, { method: 'PUT' }, session);
  }
  await removeDraft(current.clientVisitId);
}

async function syncQueuedVisits() {
  const session = await getSession();
  if (!session?.userId || !session.accessToken) throw new Error('No saved field session is available. Sign in while connected to sync visits.');
  const drafts = await getDrafts(session.userId);
  for (const draft of drafts.filter((item) => item.completed)) await syncDraft(draft, session);
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => client.postMessage({ type: 'DDIN_OFFLINE_QUEUE_UPDATED' }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    const response = await fetch('/');
    const html = await response.clone().text();
    await cache.put('/', response);
    const bundles = [...html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css)(?:\?[^\"]*)?)"/g)].map((match) => match[1]);
    if (bundles.length) await cache.addAll(bundles);
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/')));
    return;
  }
  if (['script', 'style', 'image'].includes(event.request.destination)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'ddin-visit-sync') event.waitUntil(syncQueuedVisits());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'DDIN_SYNC_VISITS') event.waitUntil?.(syncQueuedVisits());
});
