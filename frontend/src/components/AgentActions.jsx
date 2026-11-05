import React, { useMemo, useState } from 'react';
import { ArrowRightLeft, Send } from 'lucide-react';
import api from '../api';

const assignedIds = (assignments = []) => assignments.map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean);

export default function AgentActions({ agent, assignedTerritories = [], onAgentChange }) {
  const [territories, setTerritories] = useState([]);
  const [transferTargets, setTransferTargets] = useState([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [loadedTransferTargets, setLoadedTransferTargets] = useState(false);
  const [territoryId, setTerritoryId] = useState(agent.territoryId || '');
  const [sectorId, setSectorId] = useState('');
  const [cellId, setCellId] = useState('');
  const [villageId, setVillageId] = useState('');
  const [reason, setReason] = useState('');
  const [relocation, setRelocation] = useState(agent.relocationRequests?.[0] || null);
  const [transferTerritoryId, setTransferTerritoryId] = useState('');
  const [recipientTcId, setRecipientTcId] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const assigned = useMemo(() => assignedIds(assignedTerritories), [assignedTerritories]);
  const districts = useMemo(() => territories.filter((item) => item.type === 'DISTRICT' && item.isActive && assigned.includes(item.id)), [territories, assigned]);
  const sectors = useMemo(() => territories.filter((item) => item.type === 'SECTOR' && item.isActive && item.parentId === territoryId), [territories, territoryId]);
  const cells = useMemo(() => territories.filter((item) => item.type === 'CELL' && item.isActive && item.parentId === sectorId), [territories, sectorId]);
  const villages = useMemo(() => territories.filter((item) => item.type === 'VILLAGE' && item.isActive && item.parentId === cellId), [territories, cellId]);
  const activeTransfer = agent.transfers?.find((item) => item.status === 'PENDING');

  const loadTerritories = async () => {
    if (territories.length) return;
    try {
      const { data } = await api.get('/api/v1/territories');
      setTerritories(data || []);
    } catch (err) { setError(err.response?.data?.error || 'Could not load your assigned areas.'); }
  };

  const requestRelocation = async (event) => {
    event.preventDefault(); setError(''); setNotice('');
    setSaving(true);
    try {
      const { data } = await api.post(`/api/v1/agents/${agent.id}/relocation-requests`, { territoryId, sectorId, cellId, villageId, reason: reason.trim() });
      const request = { ...data, toTerritory: districts.find((item) => item.id === data.toTerritoryId) };
      setRelocation(request);
      onAgentChange?.({ ...agent, relocationRequests: [request] });
      setNotice('Relocation request sent. An administrator will review it before the agent’s location changes.');
    } catch (err) { setError(err.response?.data?.error || 'Could not send the relocation request.'); }
    finally { setSaving(false); }
  };

  const openTransfer = async () => {
    setTransferOpen((open) => !open);
    setError(''); setNotice('');
    if (loadedTransferTargets) return;
    setLoadedTransferTargets(true);
    try {
      const { data } = await api.get(`/api/v1/agents/${agent.id}/transfer-targets`);
      setTransferTargets(data || []);
      setTransferTerritoryId(data?.[0]?.id || '');
      setRecipientTcId(data?.[0]?.coordinators?.[0]?.id || '');
    } catch (err) { setError(err.response?.data?.error || 'Could not load destination coordinators.'); }
  };

  const requestTransfer = async (event) => {
    event.preventDefault(); setError(''); setNotice('');
    if (!transferTerritoryId || !recipientTcId) { setError('Choose a destination district and coordinator.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post(`/api/v1/agents/${agent.id}/transfer`, { toTerritoryId: transferTerritoryId, recipientTcId, reason: transferReason.trim() });
      onAgentChange?.({ ...agent, transfers: [...(agent.transfers || []), data] });
      setNotice('Transfer request sent. The receiving TC will call the agent and confirm the move.');
      setTransferOpen(false);
    } catch (err) { setError(err.response?.data?.error || 'Could not send the transfer request.'); }
    finally { setSaving(false); }
  };

  const currentTransfer = activeTransfer?.toTerritory?.name || 'another TC’s district';
  return <section className="surface-card agent-request-card">
    <div className="detail-panel-heading"><span className="detail-icon gps-icon"><ArrowRightLeft size={17} /></span><div><h3>Agent moves</h3><p>First location capture is one-time. Later moves require admin approval or a destination TC review.</p></div></div>

    {relocation ? <div className="agent-request-status" role="status"><strong>Relocation awaiting admin review</strong><span>Requested {new Date(relocation.requestedAt).toLocaleDateString()} · the current area remains active until approval; capture new GPS during the next visit after approval.</span></div> : activeTransfer ? null : agent.firstVisitLocationCapturedAt && !agent.tcRelocationUsed ? <form className="agent-relocation-form" onSubmit={requestRelocation}>
      <h4>Request a move inside your assigned areas</h4>
      <p>An administrator must approve this change. The TC will capture the new GPS during the agent’s next visit after approval.</p>
      <div className="agent-relocation-grid">
        <label>District<select value={territoryId} onChange={(event) => { setTerritoryId(event.target.value); setSectorId(''); setCellId(''); setVillageId(''); void loadTerritories(); }} onFocus={() => void loadTerritories()} required><option value="">Choose district</option>{districts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Sector<select value={sectorId} onChange={(event) => { setSectorId(event.target.value); setCellId(''); setVillageId(''); }} onFocus={() => void loadTerritories()} required><option value="">Choose sector</option>{sectors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Cell<select value={cellId} onChange={(event) => { setCellId(event.target.value); setVillageId(''); }} required disabled={!sectorId}><option value="">Choose cell</option>{cells.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Village<select value={villageId} onChange={(event) => setVillageId(event.target.value)} required disabled={!cellId}><option value="">Choose village</option>{villages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
      <label className="agent-request-reason">Reason<textarea rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why does the agent need this location update?" /></label>
      <div className="agent-request-actions"><button className="btn btn-primary" type="submit" disabled={saving || !sectorId || !cellId || !villageId}><Send size={15} />{saving ? 'Sending…' : 'Send to admin'}</button></div>
    </form> : agent.tcRelocationUsed ? <div className="agent-request-status"><strong>The TC relocation allowance has been used</strong><span>Ask an administrator to make any further move. Transfers to another TC’s district remain available.</span></div> : <div className="agent-request-status"><strong>Complete the first location capture first</strong><span>Once the agent’s initial location is recorded, you can request one admin-reviewed relocation inside your assigned areas. The new GPS is captured on the next visit.</span></div>}

    <div className="agent-transfer-section">
      {activeTransfer ? <div className="agent-request-status"><strong>{activeTransfer.acceptedAt ? 'Transfer accepted — record the new location before visiting' : `Transfer request pending in ${currentTransfer}`}</strong><span>{activeTransfer.acceptedAt ? 'Open Start visit to capture the agent’s current GPS and village.' : 'The agent remains assigned to this district until the receiving TC reviews the request.'}</span></div> : <>
        <button type="button" className="agent-transfer-toggle" onClick={openTransfer}><ArrowRightLeft size={15} />{transferOpen ? 'Close transfer request' : 'Transfer to another TC’s district'}</button>
        {transferOpen && <form className="agent-relocation-form" onSubmit={requestTransfer}>
          {!transferTargets.length && loadedTransferTargets ? <p>No active TC is assigned to another district yet.</p> : <>
            <label>Destination district<select value={transferTerritoryId} onChange={(event) => { const target = transferTargets.find((item) => item.id === event.target.value); setTransferTerritoryId(event.target.value); setRecipientTcId(target?.coordinators?.[0]?.id || ''); }} required><option value="">Choose district</option>{transferTargets.map((item) => <option key={item.id} value={item.id}>{item.name}{item.province ? ` — ${item.province}` : ''}</option>)}</select></label>
            <label>Receiving TC<select value={recipientTcId} onChange={(event) => setRecipientTcId(event.target.value)} required><option value="">Choose coordinator</option>{(transferTargets.find((item) => item.id === transferTerritoryId)?.coordinators || []).map((tc) => <option key={tc.id} value={tc.id}>{[tc.firstName, tc.lastName].filter(Boolean).join(' ')}</option>)}</select></label>
            <label className="agent-request-reason">Reason<textarea rows={2} maxLength={500} value={transferReason} onChange={(event) => setTransferReason(event.target.value)} placeholder="Where the agent moved, if known" /></label>
            <button className="btn btn-primary" type="submit" disabled={saving || !transferTargets.length}><Send size={15} />{saving ? 'Sending…' : 'Send transfer for TC review'}</button>
          </>}
        </form>}
      </>}
    </div>
    {error && <p className="agent-request-error" role="alert">{error}</p>}
    {notice && <p className="agent-request-notice" role="status">{notice}</p>}
  </section>;
}
