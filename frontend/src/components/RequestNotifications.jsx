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
  const [error, setError] = useState('');
  const dismissed = useRef(new Set());
  const endpoint = role === 'ADMIN' ? '/api/v1/agents/relocation-requests' : '/api/v1/agents/transfer-inbox';
  const isAdmin = role === 'ADMIN';

  const load = useCallback(async () => {
    if (!['ADMIN', 'TC'].includes(role)) return;
    try {
      const { data } = await api.get(endpoint);
      const rows = Array.isArray(data) ? data : [];
      setRequests(rows);
      setError('');
      const next = rows.find((item) => !dismissed.current.has(item.id));
      if (next) setOpen(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not check for territory requests.');
    }
  }, [endpoint, role]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 45000);
    return () => window.clearInterval(timer);
  }, [load]);

  const current = requests.find((item) => !dismissed.current.has(item.id)) || requests[0];
  const close = () => {
    if (current) dismissed.current.add(current.id);
    setOpen(false);
    setConfirmed(false);
    setError('');
  };

  const review = async (decision) => {
    if (!current) return;
    if (!isAdmin && decision === 'ACCEPT' && !confirmed) return;
    setBusyId(current.id); setError('');
    try {
      const path = isAdmin
        ? `/api/v1/agents/relocation-requests/${current.id}/review`
        : `/api/v1/agents/transfer-requests/${current.id}/review`;
      await api.put(path, { decision, ...(decision === 'REJECT' ? { note: isAdmin ? 'Relocation request rejected by administrator.' : 'Destination TC could not confirm the agent.' } : {}) });
      dismissed.current.add(current.id);
      const remaining = requests.filter((item) => item.id !== current.id);
      setRequests(remaining);
      setConfirmed(false);
      if (!remaining.length) setOpen(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not review this request. Refresh and try again.');
    } finally { setBusyId(''); }
  };

  if (!['ADMIN', 'TC'].includes(role)) return null;
  return <>
    {requests.length > 0 && <div className="request-notification-banner" role="status">
      <span className="request-notification-icon"><ShieldAlert size={19} /></span>
      <span><strong>{requests.length} request{requests.length === 1 ? '' : 's'} need your review</strong><small>{isAdmin ? 'TC agent relocation requests' : 'Incoming agent transfers for your district'}</small></span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setOpen(true); setError(''); }}>Review requests</button>
    </div>}
    {error && requests.length === 0 && <p className="request-notification-load-error" role="status">{error}</p>}
    {open && current && <div className="request-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="request-modal" role="dialog" aria-modal="true" aria-labelledby="request-modal-title">
        <button type="button" className="request-modal-close" aria-label="Close request" onClick={close}><X size={19} /></button>
        <span className="request-modal-kicker">{isAdmin ? 'ADMIN REVIEW' : 'NEW AGENT TRANSFER'}</span>
        <h2 id="request-modal-title">{isAdmin ? 'Review relocation request' : 'Confirm the agent is in your territory'}</h2>
        <p className="request-modal-intro">{isAdmin ? 'Review the requested change and approve or reject it. The current location stays in use until approval.' : 'Call the agent, confirm they are physically in your district, then accept the transfer.'}</p>
        <div className="request-agent-summary">
          <div><small>AGENT</small><strong>{current.agent?.name || 'Unknown agent'}</strong><span>Agent number: {current.agent?.agentId || '—'}</span></div>
          <div><small>PHONE NUMBER</small>{current.agent?.phoneNumber ? <a className="request-phone-link" href={`tel:${telValue(current.agent.phoneNumber)}`}><Phone size={17} />{current.agent.phoneNumber}</a> : <strong className="request-no-phone">No phone number on record</strong>}</div>
        </div>
        <div className="request-route"><div><small>FROM</small><strong>{current.fromTerritory?.name || current.agent?.territory?.name || 'Current district'}</strong>{current.fromTerritory?.parent?.name && <span>{current.fromTerritory.parent.name}</span>}</div><span className="request-route-arrow">→</span><div><small>TO</small><strong>{isAdmin ? current.destinationPath || current.toTerritory?.name : current.toTerritory?.name || 'Destination district'}</strong>{!isAdmin && current.toTerritory?.parent?.name && <span>{current.toTerritory.parent.name}</span>}</div></div>
        {current.reason && <div className="request-reason"><small>NOTE FROM REQUESTER</small><p>{current.reason}</p></div>}
        <p className="request-submitted-by">Requested by {fullName(current.requestedByTc)} · {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(current.requestedAt))}</p>
        {!isAdmin && <label className="request-confirm-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={!current.agent?.phoneNumber} /><span>I called this number and confirmed the agent is in my territory.</span></label>}
        {error && <p className="request-modal-error" role="alert">{error}</p>}
        <div className="request-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={() => review('REJECT')} disabled={busyId === current.id}>{busyId === current.id ? 'Saving…' : 'Reject'}</button>
          <button type="button" className="btn btn-primary" onClick={() => review(isAdmin ? 'APPROVE' : 'ACCEPT')} disabled={busyId === current.id || (!isAdmin && (!confirmed || !current.agent?.phoneNumber))}><Check size={16} />{busyId === current.id ? 'Saving…' : isAdmin ? 'Approve relocation' : 'Confirm and accept'}</button>
        </div>
      </section>
    </div>}
  </>;
}
