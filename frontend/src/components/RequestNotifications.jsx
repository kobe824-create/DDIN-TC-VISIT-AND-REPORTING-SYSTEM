import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Phone, ShieldAlert, X } from 'lucide-react';
import api from '../api';

const fullName = (person) => [person?.firstName, person?.lastName].filter(Boolean).join(' ') || 'Coordinator';
const telValue = (value) => String(value || '').replace(/[^\d+]/g, '');

export default function RequestNotifications({ role }) {
  const [requests, setRequests] = useState([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [targets, setTargets] = useState([]);
  const [destinationId, setDestinationId] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [error, setError] = useState('');
  const dismissed = useRef(new Set());
  const isAdmin = role === 'ADMIN';

  const load = useCallback(async () => {
    if (!['ADMIN', 'TC'].includes(role)) return;
    try {
      let rows = [];
      if (isAdmin) {
        const results = await Promise.allSettled([
          api.get('/api/v1/agents/relocation-requests'),
          api.get('/api/v1/visits/moola-plus/relocation-requests'),
          api.get('/api/v1/agents/transfer-holds'),
          api.get('/api/v1/reports/field-progress/follow-ups'),
          api.get('/api/v1/visits/moola-plus/transfer-holds'),
        ]);
        const iremboRows = results[0].status === 'fulfilled' && Array.isArray(results[0].value.data) ? results[0].value.data : [];
        const moolaRows = results[1].status === 'fulfilled' && Array.isArray(results[1].value.data) ? results[1].value.data.map((item) => ({ ...item, network: 'MOOLA_PLUS', kind: 'MOOLA_RELOCATION', agent: { name: item.agentName, agentId: item.loginName } })) : [];
        const heldRows = results[2].status === 'fulfilled' && Array.isArray(results[2].value.data) ? results[2].value.data.map((item) => ({ ...item, network: 'IREMBO_TRANSFER_HOLD', kind: 'TRANSFER_HOLD' })) : [];
        const followUpRows = results[3].status === 'fulfilled' && Array.isArray(results[3].value.data?.data) ? results[3].value.data.data.map((item) => ({ ...item, network: 'FIELD_FOLLOW_UP', kind: 'FIELD_FOLLOW_UP' })) : [];
        const moolaHeldRows = results[4].status === 'fulfilled' && Array.isArray(results[4].value.data) ? results[4].value.data.map((item) => ({ ...item, network: 'MOOLA_PLUS_TRANSFER_HOLD', kind: 'TRANSFER_HOLD', agent: { name: item.agentName, agentId: item.loginName, phoneNumber: item.phoneNumber } })) : [];
        rows = [...followUpRows, ...heldRows, ...moolaHeldRows, ...iremboRows, ...moolaRows];
      } else {
        const results = await Promise.allSettled([
          api.get('/api/v1/agents/transfer-inbox'),
          api.get('/api/v1/visits/moola-plus/transfer-inbox'),
          api.get('/api/v1/agents/movement-notices'),
        ]);
        const iremboTransfers = results[0].status === 'fulfilled' && Array.isArray(results[0].value.data) ? results[0].value.data : [];
        const moolaTransfers = results[1].status === 'fulfilled' && Array.isArray(results[1].value.data) ? results[1].value.data.map((item) => ({ ...item, network: 'MOOLA_PLUS_TRANSFER', kind: 'MOOLA_TRANSFER', agent: { name: item.agentName, agentId: item.loginName, phoneNumber: item.phoneNumber } })) : [];
        const movementNotices = results[2].status === 'fulfilled' && Array.isArray(results[2].value.data) ? results[2].value.data.map((item) => ({ ...item, network: `MOVEMENT_${item.network}`, kind: 'MOVEMENT_NOTICE' })) : [];
        rows = [...movementNotices, ...moolaTransfers, ...iremboTransfers];
      }
      setRequests(rows);
      setError('');
      const next = rows.find((item) => !dismissed.current.has(`${item.network || 'IREMBO'}-${item.id}`));
      if (next) setOpen(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not check for territory requests.');
    }
  }, [isAdmin, role]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 45000);
    return () => window.clearInterval(timer);
  }, [load]);

  const current = requests.find((item) => !dismissed.current.has(`${item.network || 'IREMBO'}-${item.id}`)) || requests[0];
  useEffect(() => { setReviewNote(''); setConfirmed(false); setError(''); }, [current?.id]);
  useEffect(() => {
    if (!isAdmin || current?.kind !== 'TRANSFER_HOLD') { setTargets([]); setDestinationId(''); setRecipientId(''); return; }
    let active = true;
    const targetPath = current.network === 'MOOLA_PLUS_TRANSFER_HOLD' ? '/api/v1/visits/moola-plus/transfer-hold-targets' : '/api/v1/agents/transfer-hold-targets';
    api.get(targetPath).then(({ data }) => {
      if (!active) return;
      setTargets(data || []);
      const first = data?.[0];
      setDestinationId(first?.id || '');
      setRecipientId(first?.coordinators?.[0]?.id || '');
    }).catch((err) => { if (active) setError(err.response?.data?.error || 'Could not load active TC destinations.'); });
    return () => { active = false; };
  }, [current?.id, current?.kind, isAdmin]);
  const close = () => {
    if (current) dismissed.current.add(`${current.network || 'IREMBO'}-${current.id}`);
    setOpen(false);
    setConfirmed(false);
    setReviewNote('');
    setError('');
  };

  const review = async (decision) => {
    if (!current) return;
    if (current.kind === 'FIELD_FOLLOW_UP' && !isAdmin) return;
    if (!isAdmin && decision === 'ACCEPT' && !current.adminRoutedAt && !confirmed) return;
    if (!isAdmin && decision === 'REJECT' && !reviewNote.trim()) { setError('Enter a reason for rejecting this transfer.'); return; }
    setBusyId(current.id); setError('');
    try {
      if (current.kind === 'FIELD_FOLLOW_UP') {
        await api.put(`/api/v1/reports/field-progress/follow-ups/${current.id}/review`, { status: decision, reviewNote: reviewNote.trim() });
      } else if (current.kind === 'MOVEMENT_NOTICE') {
        await api.patch(`/api/v1/agents/movement-notices/${current.id}/read`);
      } else if (current.kind === 'MOOLA_RELOCATION') {
        await api.post(`/api/v1/visits/moola-plus/relocation-requests/${current.id}/review`, { action: decision, reviewNote: decision === 'REJECT' ? 'Relocation request rejected by administrator.' : '' });
      } else if (current.kind === 'MOOLA_TRANSFER') {
        await api.put(`/api/v1/visits/moola-plus/transfer-requests/${current.id}/review`, { decision, ...(decision === 'REJECT' ? { note: reviewNote.trim() } : {}) });
      } else {
        const path = isAdmin ? `/api/v1/agents/relocation-requests/${current.id}/review` : `/api/v1/agents/transfer-requests/${current.id}/review`;
        await api.put(path, { decision, ...(decision === 'REJECT' ? { note: isAdmin ? 'Relocation request rejected by administrator.' : reviewNote.trim() } : {}) });
      }
      dismissed.current.add(`${current.network || 'IREMBO'}-${current.id}`);
      const remaining = requests.filter((item) => item.id !== current.id || (item.network || 'IREMBO') !== (current.network || 'IREMBO'));
      setRequests(remaining);
      setConfirmed(false);
      setReviewNote('');
      if (!remaining.length) setOpen(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not review this request. Refresh and try again.');
    } finally { setBusyId(''); }
  };

  const routeHeldAgent = async () => {
    if (!current || !destinationId || !recipientId) { setError('Choose a destination district and TC.'); return; }
    setBusyId(current.id); setError('');
    try {
      const path = current.network === 'MOOLA_PLUS_TRANSFER_HOLD' ? `/api/v1/visits/moola-plus/transfer-holds/${current.id}/route` : `/api/v1/agents/transfer-holds/${current.id}/route`;
      await api.put(path, { toTerritoryId: destinationId, recipientTcId: recipientId });
      const key = `${current.network}-${current.id}`;
      dismissed.current.add(key);
      const remaining = requests.filter((item) => item.id !== current.id || item.network !== current.network);
      setRequests(remaining);
      if (!remaining.length) setOpen(false);
    } catch (err) { setError(err.response?.data?.error || 'Could not send this agent to the selected TC.'); }
    finally { setBusyId(''); }
  };

  if (!['ADMIN', 'TC'].includes(role)) return null;
  return <>
    {requests.length > 0 && <div className="request-notification-banner" role="status">
      <span className="request-notification-icon"><ShieldAlert size={19} /></span>
        <span><strong>{requests.length} item{requests.length === 1 ? '' : 's'} need your review</strong><small>{isAdmin ? 'Field follow-ups, agent transfers and relocations' : 'Incoming transfers and agent movement updates'}</small></span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setOpen(true); setError(''); }}>Review requests</button>
    </div>}
    {error && requests.length === 0 && <p className="request-notification-load-error" role="status">{error}</p>}
    {open && current && <div className="request-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="request-modal" role="dialog" aria-modal="true" aria-labelledby="request-modal-title">
        <button type="button" className="request-modal-close" aria-label="Close request" onClick={close}><X size={19} /></button>
        {current.kind === 'FIELD_FOLLOW_UP' ? <>
          <span className="request-modal-kicker">FIELD PERFORMANCE · ADMIN FOLLOW-UP</span>
          <h2 id="request-modal-title">Review a missed field target</h2>
          <p className="request-modal-intro">This weekday target was not met. Weekends are excluded from follow-up reporting.</p>
          <div className="request-agent-summary">
            <div><small>COORDINATOR</small><strong>{fullName(current.tc)}</strong><span>{current.tc?.username || 'Field coordinator'}</span></div>
            <div><small>FIELD DATE</small><strong>{new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Africa/Kigali' }).format(new Date(`${String(current.workDate).slice(0, 10)}T12:00:00`))}</strong><span>{current.missedAgents} agent{current.missedAgents === 1 ? '' : 's'} below target</span></div>
          </div>
          <div className="request-route-fields follow-up-counts">
            <div><small>REQUIRED</small><strong>{current.requiredAgents}</strong></div>
            <div><small>COMPLETED</small><strong>{current.completedAgents}</strong></div>
            <div><small>MISSED</small><strong>{current.missedAgents}</strong></div>
          </div>
          {current.reviewNote && <div className="request-reason"><small>PREVIOUS REVIEW NOTE</small><p>{current.reviewNote}</p></div>}
          <label className="request-rejection-field">Admin follow-up note<textarea className="input" rows={2} maxLength={500} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="Optional note for the coordinator" /></label>
          {error && <p className="request-modal-error" role="alert">{error}</p>}
          <div className="request-modal-actions">
            <button type="button" className="btn btn-secondary" onClick={() => review('ACKNOWLEDGED')} disabled={busyId === current.id}>{busyId === current.id ? 'Saving…' : 'Acknowledge'}</button>
            <button type="button" className="btn btn-primary" onClick={() => review('RESOLVED')} disabled={busyId === current.id}><Check size={16} />{busyId === current.id ? 'Saving…' : 'Mark resolved'}</button>
          </div>
        </> : current.kind === 'MOVEMENT_NOTICE' ? <>
          <span className="request-modal-kicker">AGENT MOVEMENT UPDATE</span>
          <h2 id="request-modal-title">{current.noticeType === 'RELOCATED' ? 'An agent was relocated' : 'An agent transfer was routed'}</h2>
          <p className="request-modal-intro">{current.noticeType === 'RELOCATED' ? `${current.agentName} moved from ${current.fromTerritoryName || 'the previous district'} to ${current.toTerritoryName || 'a new district'}.` : `An administrator routed ${current.agentName} from ${current.fromTerritoryName || 'the previous district'} to ${current.toTerritoryName || 'a new district'}. The receiving TC will see a separate request to accept the transfer.`} This update was sent to the TCs responsible for the old and new territories.</p>
          <div className="request-modal-actions"><button type="button" className="btn btn-primary" onClick={() => review('ACKNOWLEDGE')} disabled={busyId === current.id}><Check size={16} />{busyId === current.id ? 'Saving…' : 'Acknowledge'}</button></div>
        </> : <>
        <span className="request-modal-kicker">{current.kind === 'TRANSFER_HOLD' ? 'TRANSFER ON HOLD · ADMIN' : current.kind === 'MOOLA_RELOCATION' ? 'MOOLA PLUS · ADMIN REVIEW' : isAdmin ? 'ADMIN REVIEW' : current.network === 'MOOLA_PLUS_TRANSFER' ? 'MOOLA PLUS TRANSFER' : 'NEW AGENT TRANSFER'}</span>
        <h2 id="request-modal-title">{current.kind === 'TRANSFER_HOLD' ? 'Choose a new territory for this agent' : isAdmin ? 'Review relocation request' : 'Confirm the agent is in your territory'}</h2>
        <p className="request-modal-intro">{current.kind === 'TRANSFER_HOLD' ? 'The receiving TC rejected this transfer. The agent is on hold until you assign a new TC.' : current.kind === 'MOOLA_RELOCATION' ? 'Review the destination district. After approval, the next Moola Plus visit records the new field GPS.' : isAdmin ? 'Review the requested change and approve or reject it. The current location stays in use until approval.' : current.adminRoutedAt ? 'The administrator has routed this agent to your district. Calling to confirm is optional; accept to take responsibility for the agent.' : 'Call the agent, confirm they are physically in your district, then accept the transfer.'}</p>
        <div className="request-agent-summary">
          <div><small>AGENT</small><strong>{current.agent?.name || current.agentName || 'Unknown agent'}</strong><span>{current.network === 'MOOLA_PLUS' ? 'Login' : 'Agent number'}: {current.agent?.agentId || current.loginName || '—'}</span></div>
          <div><small>PHONE NUMBER</small>{(current.agent?.phoneNumber || current.phoneNumber) ? <a className="request-phone-link" href={`tel:${telValue(current.agent?.phoneNumber || current.phoneNumber)}`}><Phone size={17} />{current.agent?.phoneNumber || current.phoneNumber}</a> : <strong className="request-no-phone">No phone number on record</strong>}</div>
        </div>
        <div className="request-route"><div><small>FROM</small><strong>{current.fromTerritory?.name || current.agent?.territory?.name || 'Current district'}</strong>{current.fromTerritory?.parent?.name && <span>{current.fromTerritory.parent.name}</span>}</div><span className="request-route-arrow">→</span><div><small>TO</small><strong>{current.kind === 'TRANSFER_HOLD' ? 'Choose a new destination below' : isAdmin ? current.destinationPath || current.toTerritory?.name : current.toTerritory?.name || 'Destination district'}</strong>{current.kind !== 'TRANSFER_HOLD' && !isAdmin && current.toTerritory?.parent?.name && <span>{current.toTerritory.parent.name}</span>}</div></div>
        {current.reason && <div className="request-reason"><small>NOTE FROM REQUESTER</small><p>{current.reason}</p></div>}
        {current.reviewNote && <div className="request-reason"><small>REJECTION REASON</small><p>{current.reviewNote}</p></div>}
        <p className="request-submitted-by">Requested by {fullName(current.requestedByTc)} · {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(current.requestedAt))}</p>
        {current.kind === 'TRANSFER_HOLD' && <div className="request-route-fields">
          <label>Destination district<select className="input" value={destinationId} onChange={(event) => { const target = targets.find((item) => item.id === event.target.value); setDestinationId(event.target.value); setRecipientId(target?.coordinators?.[0]?.id || ''); }}><option value="">Choose district</option>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}{target.province ? ` · ${target.province}` : ''}</option>)}</select></label>
          <label>Receiving TC<select className="input" value={recipientId} onChange={(event) => setRecipientId(event.target.value)}><option value="">Choose TC</option>{(targets.find((item) => item.id === destinationId)?.coordinators || []).map((tc) => <option key={tc.id} value={tc.id}>{fullName(tc)}</option>)}</select></label>
        </div>}
        {!isAdmin && !current.adminRoutedAt && <label className="request-confirm-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={!(current.agent?.phoneNumber || current.phoneNumber)} /><span>I called this number and confirmed the agent is in my territory.</span></label>}
        {!isAdmin && current.adminRoutedAt && <label className="request-confirm-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I called the agent to confirm their arrival (optional).</span></label>}
        {!isAdmin && <label className="request-rejection-field">Reason for rejection<textarea className="input" rows={2} maxLength={500} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="Explain why you cannot accept this agent" /></label>}
        {error && <p className="request-modal-error" role="alert">{error}</p>}
        <div className="request-modal-actions">
          {current.kind === 'TRANSFER_HOLD' ? <button type="button" className="btn btn-primary" onClick={routeHeldAgent} disabled={busyId === current.id || !destinationId || !recipientId}><Check size={16} />{busyId === current.id ? 'Sending…' : 'Assign to TC'}</button> : <>
            <button type="button" className="btn btn-secondary" onClick={() => review('REJECT')} disabled={busyId === current.id || (!isAdmin && !reviewNote.trim())}>{busyId === current.id ? 'Saving…' : 'Reject'}</button>
            <button type="button" className="btn btn-primary" onClick={() => review(isAdmin ? 'APPROVE' : 'ACCEPT')} disabled={busyId === current.id || (!isAdmin && !current.adminRoutedAt && (!confirmed || !(current.agent?.phoneNumber || current.phoneNumber)))}><Check size={16} />{busyId === current.id ? 'Saving…' : isAdmin ? 'Approve relocation' : 'Accept transfer'}</button>
          </>}
        </div>
        </>}
      </section>
    </div>}
  </>;
}
