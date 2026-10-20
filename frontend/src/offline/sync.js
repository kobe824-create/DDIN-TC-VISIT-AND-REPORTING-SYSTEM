import api from '../api';
import { deleteVisitDraft, getVisitDrafts, notifyQueueUpdate, saveVisitDraft } from './store';

function photoFile(draft) {
  if (!draft.photoBlob) return null;
  const filename = draft.photoName || `visit-${draft.clientVisitId}.jpg`;
  return new File([draft.photoBlob], filename, { type: draft.photoType || draft.photoBlob.type || 'image/jpeg' });
}

async function syncOne(draft) {
  if (!draft.completed) return { synced: false, draft, reason: 'Finish this visit before synchronizing it.' };
  if (!draft.reportPayload || !draft.photoBlob) return { synced: false, draft, reason: 'The visit report and photo must be saved before synchronization.' };

  let current = { ...draft };
  if (!current.serverVisitId) {
    const { data } = await api.post('/api/v1/visits/sync', [{
      visitId: current.clientVisitId,
      agentId: current.agentId,
      tcLatitude: current.tcLatitude,
      tcLongitude: current.tcLongitude,
      gpsAccuracyMeters: current.gpsAccuracyMeters,
      visitDate: current.visitDate,
      checkInTime: current.checkInTime,
      agentLocation: current.agentLocation || null,
    }]);
    const synced = data.syncedVisits?.find((visit) => visit.clientVisitId === current.clientVisitId);
    if (!synced?.id) throw new Error('The server did not confirm the visit check-in. Keep this visit on the device and retry.');
    current.serverVisitId = synced.id;
    current.publicVisitId = synced.visitId;
    await saveVisitDraft(current, { scheduleSync: false });
  }

  const { data: serverVisit } = await api.get(`/api/v1/visits/${current.serverVisitId}`);
  if (!serverVisit.photos?.length) {
    const file = photoFile(current);
    if (!file) throw new Error('The saved visit photo is missing from this device.');
    const formData = new FormData();
    formData.append('photo', file);
    await api.put(`/api/v1/visits/${current.serverVisitId}/photo`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
  }
  if (!serverVisit.report && current.reportPayload) {
    await api.post(`/api/v1/visits/${current.serverVisitId}/report`, current.reportPayload);
  }
  if (!['COMPLETED', 'FLAGGED'].includes(serverVisit.visitStatus)) {
    await api.put(`/api/v1/visits/${current.serverVisitId}/check-out`);
  }
  await deleteVisitDraft(current.clientVisitId);
  return { synced: true, visitId: current.publicVisitId || current.clientVisitId };
}

export async function syncPendingVisits(userId) {
  if (!navigator.onLine) return { syncedCount: 0, pendingCount: (await getVisitDrafts(userId)).filter((item) => item.completed).length, errors: [] };
  const drafts = (await getVisitDrafts(userId)).filter((item) => item.completed);
  const errors = [];
  let syncedCount = 0;
  for (const draft of drafts) {
    try {
      const result = await syncOne(draft);
      if (result.synced) syncedCount += 1;
      else if (result.reason) errors.push({ visitId: draft.clientVisitId, message: result.reason });
    } catch (error) {
      errors.push({ visitId: draft.clientVisitId, message: error.response?.data?.error || error.message || 'Sync failed.' });
    }
  }
  notifyQueueUpdate();
  const remaining = (await getVisitDrafts(userId)).filter((item) => item.completed).length;
  return { syncedCount, pendingCount: remaining, errors };
}

export async function queueCurrentVisitDraft(draft) {
  await saveVisitDraft(draft);
}
