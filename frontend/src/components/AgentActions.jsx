import React, { useMemo, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, MapPin, Send } from 'lucide-react';
import api from '../api';

const assignedIds = (assignments = []) => assignments.map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean);

export default function AgentActions({ agent, assignedTerritories = [], onAgentChange }) {
  const [territories, setTerritories] = useState([]);
  const [territoriesStatus, setTerritoriesStatus] = useState('idle');
  const [mode, setMode] = useState('');
  const [sectorId, setSectorId] = useState(agent.sectorId || '');
  const [cellId, setCellId] = useState(agent.cellId || '');
  const [villageId, setVillageId] = useState(agent.villageId || '');
  const [venue, setVenue] = useState(agent.venue || '');
  const [reason, setReason] = useState('');
  const [relocation, setRelocation] = useState(agent.relocationRequests?.[0] || null);
  const [transferTargets, setTransferTargets] = useState([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTargetsStatus, setTransferTargetsStatus] = useState('idle');
  const [transferTerritoryId, setTransferTerritoryId] = useState('');
  const [recipientTcId, setRecipientTcId] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const assigned = useMemo(() => assignedIds(assignedTerritories), [assignedTerritories]);
  const currentDistrict = agent.territory?.name || 'Current district';
  const territoryId = agent.territoryId;
  const sectors = useMemo(() => territories.filter((item) => item.type === 'SECTOR' && item.isActive && item.parentId === territoryId), [territories, territoryId]);
  const cells = useMemo(() => territories.filter((item) => item.type === 'CELL' && item.isActive && item.parentId === sectorId), [territories, sectorId]);
  const villages = useMemo(() => territories.filter((item) => item.type === 'VILLAGE' && item.isActive && item.parentId === cellId), [territories, cellId]);
  const activeTransfer = agent.transfers?.find((item) => ['PENDING', 'ON_HOLD'].includes(item.status));
  const hasUsedMove = Boolean(agent.tcMoveUsed);

  const loadTerritories = async () => {
    if (territoriesStatus === 'loading' || territoriesStatus === 'loaded') return;
    setTerritoriesStatus('loading');
    setError('');
    try {
      const { data } = await api.get('/api/v1/territories');
      setTerritories(data || []);
      setTerritoriesStatus('loaded');
    } catch (err) {
      setTerritoriesStatus('error');
      setError(err.response?.data?.error || 'Could not load the official territory list.');
    }
  };

  const openLocationForm = () => {
    setMode(hasUsedMove ? 'REQUEST' : 'FIRST');
    setError('');
    setNotice('');
    setReason('');
    setSectorId(agent.sectorId || '');
    setCellId(agent.cellId || '');
    setVillageId(agent.villageId || '');
    setVenue(agent.venue || '');
    void loadTerritories();
  };

  const submitLocation = async (event) => {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!territoryId || !sectorId || !cellId || !villageId || !venue.trim()) {
      setError('Choose the sector, cell and village, and enter the venue.');
      return;
    }
    setSaving(true);
    try {
      if (mode === 'FIRST') {
        const { data } = await api.patch(`/api/v1/agents/${encodeURIComponent(agent.id)}/location-details`, {
          territoryId, sectorId, cellId, villageId, venue: venue.trim(),
        });
        onAgentChange?.({ ...agent, ...data, tcMoveUsed: true });
        setNotice('The one-time in-territory location action is complete. Any further move must be requested from an administrator.');
      } else {
        const { data } = await api.post(`/api/v1/agents/${encodeURIComponent(agent.id)}/relocation-requests`, {
          territoryId, sectorId, cellId, villageId, venue: venue.trim(), reason: reason.trim(),
        });
        const request = {
          ...data,
          toTerritory: agent.territory,
          destinationPath: [currentDistrict, sectors.find((item) => item.id === sectorId)?.name, cells.find((item) => item.id === cellId)?.name, villages.find((item) => item.id === villageId)?.name].filter(Boolean).join(' · '),
          destinationVenue: venue.trim(),
        };
        setRelocation(request);
        onAgentChange?.({ ...agent, relocationRequests: [request] });
        setNotice('Relocation request sent to an administrator. The current location remains active until it is approved.');
      }
      setMode('');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the agent’s location.');
    } finally { setSaving(false); }
  };

  const loadTransferTargets = async () => {
    if (transferTargetsStatus === 'loading' || transferTargetsStatus === 'loaded') return;
    setTransferTargetsStatus('loading');
    setError('');
    setNotice('');
    try {
      const { data } = await api.get(`/api/v1/agents/${encodeURIComponent(agent.id)}/transfer-targets`);
      setTransferTargets(data || []);
      setTransferTerritoryId(data?.[0]?.id || '');
      setRecipientTcId(data?.[0]?.coordinators?.[0]?.id || '');
      setTransferTargetsStatus('loaded');
    } catch (err) {
      setTransferTargetsStatus('error');
      setError(err.response?.data?.error || 'Could not load destination coordinators.');
    }
  };

  const openTransfer = () => {
    const opening = !transferOpen;
    setTransferOpen(opening);
    setError('');
    setNotice('');
    if (opening) void loadTransferTargets();
  };

  const requestTransfer = async (event) => {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!transferTerritoryId || !recipientTcId) { setError('Choose a destination district and coordinator.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post(`/api/v1/agents/${encodeURIComponent(agent.id)}/transfer`, { toTerritoryId: transferTerritoryId, recipientTcId, reason: transferReason.trim() });
      onAgentChange?.({
        ...agent,
        ...(data.status === 'COMPLETED' ? { territoryId: data.toTerritoryId, territory: data.toTerritory, sectorId: null, cellId: null, villageId: null, venue: null, address: null, tcLocationDetailsCompletedAt: null } : {}),
        tcMoveUsed: true,
        transfers: [...(agent.transfers || []), data],
      });
      setNotice(data.adminReviewRequired
        ? 'Transfer request sent to an administrator. The agent is on hold until it is reviewed.'
        : 'The one-time transfer is complete and the agent is now assigned to the selected TC.');
      setTransferOpen(false);
    } catch (err) { setError(err.response?.data?.error || 'Could not submit the transfer.'); }
    finally { setSaving(false); }
  };

  const currentTransfer = activeTransfer?.toTerritory?.name || 'another TC’s district';
  const movementPending = Boolean(activeTransfer || relocation);
  return <section className="surface-card agent-request-card">
    <div className="detail-panel-heading"><span className="detail-icon gps-icon"><ArrowRightLeft size={17} /></span><div><h3>Agent location and moves</h3><p>Choose one first move: update the location inside your district or transfer the agent to another TC. Later moves require administrator review.</p></div></div>

    {relocation && <div className="agent-request-status" role="status"><strong>Location change awaiting administrator review</strong><span>{relocation.destinationPath || relocation.toTerritory?.name ? `Destination: ${relocation.destinationPath || relocation.toTerritory?.name}${relocation.destinationVenue || relocation.toVenue ? ` · ${relocation.destinationVenue || relocation.toVenue}` : ''} · ` : ''}Requested {relocation.requestedAt ? new Date(relocation.requestedAt).toLocaleDateString() : 'just now'} · the saved location stays active until approval.</span></div>}
    {activeTransfer && <div className="agent-request-status"><strong>{activeTransfer.status === 'ON_HOLD' ? 'Transfer request sent to an administrator' : activeTransfer.acceptedAt ? 'Transfer accepted — record the new location before visiting' : `Transfer request pending in ${currentTransfer}`}</strong><span>{activeTransfer.status === 'ON_HOLD' ? 'The agent is on hold while an administrator reviews the transfer.' : activeTransfer.acceptedAt ? 'Open Start visit to capture the agent’s current GPS and village.' : 'The agent remains assigned to this district until the receiving TC reviews the request.'}</span></div>}

    {!movementPending && <>
      <div className="agent-request-status"><strong>{hasUsedMove ? 'The TC one-time move has been used' : 'Choose the TC’s one-time move'}</strong><span>{hasUsedMove ? 'You can submit a relocation or transfer request for administrator review.' : `Locate the agent in ${currentDistrict}, or transfer the agent to another TC. Either action uses the one-time move.`}</span></div>
      <div className="agent-transfer-section">
        <button type="button" className="agent-transfer-toggle" onClick={() => mode ? setMode('') : openLocationForm()}><MapPin size={15} />{mode ? 'Close location form' : hasUsedMove ? 'Request relocation within territory' : 'Locate agent within my territory'}</button>
        {mode && <LocationForm {...{ mode, agent, territoryId, currentDistrict, sectors, cells, villages, sectorId, setSectorId, cellId, setCellId, villageId, setVillageId, venue, setVenue, reason, setReason, saving, error, territoriesStatus, onSubmit: submitLocation, onCancel: () => setMode('') }} />}
      </div>
      <div className="agent-transfer-section">
        <button type="button" className="agent-transfer-toggle" onClick={openTransfer}><ArrowRightLeft size={15} />{transferOpen ? 'Close transfer form' : hasUsedMove ? 'Request transfer from administrator' : 'Transfer to another TC'}</button>
        {transferOpen && <form className="agent-relocation-form" onSubmit={requestTransfer}>
          <label>Destination district<select value={transferTerritoryId} onChange={(event) => { const target = transferTargets.find((item) => item.id === event.target.value); setTransferTerritoryId(event.target.value); setRecipientTcId(target?.coordinators?.[0]?.id || ''); }} required disabled={transferTargetsStatus !== 'loaded' || !transferTargets.length}><option value="">{transferTargetsStatus === 'loading' ? 'Loading districts…' : 'Choose district'}</option>{transferTargets.map((item) => <option key={item.id} value={item.id}>{item.name}{item.province ? ` — ${item.province}` : ''}</option>)}</select></label>
          <label>Receiving TC<select value={recipientTcId} onChange={(event) => setRecipientTcId(event.target.value)} required disabled={transferTargetsStatus !== 'loaded' || !transferTargets.length}><option value="">{transferTargetsStatus === 'loading' ? 'Loading coordinators…' : 'Choose coordinator'}</option>{(transferTargets.find((item) => item.id === transferTerritoryId)?.coordinators || []).map((tc) => <option key={tc.id} value={tc.id}>{[tc.firstName, tc.lastName].filter(Boolean).join(' ')}</option>)}</select></label>
          <label className="agent-request-reason">Reason<textarea rows={2} maxLength={500} value={transferReason} onChange={(event) => setTransferReason(event.target.value)} placeholder="Why does the agent need to move?" /></label>
          {transferTargetsStatus === 'loading' && <p role="status">Loading available districts and coordinators…</p>}
          {transferTargetsStatus === 'loaded' && !transferTargets.length && <p role="status">No active TC is assigned to another district yet. Ask an administrator to assign a TC to the destination district.</p>}
          {transferTargetsStatus === 'error' && <button className="btn btn-secondary" type="button" onClick={() => { setTransferTargetsStatus('idle'); void loadTransferTargets(); }}>Retry loading destinations</button>}
          <button className="btn btn-primary" type="submit" disabled={saving || transferTargetsStatus !== 'loaded' || !transferTargets.length || !transferTerritoryId || !recipientTcId}><Send size={15} />{saving ? 'Submitting…' : hasUsedMove ? 'Send transfer request to admin' : 'Transfer agent now'}</button>
        </form>}
      </div>
    </>}
    {territoriesStatus === 'loading' && mode && <p className="agent-request-status" role="status">Loading the official territory list…</p>}
    {territoriesStatus === 'error' && mode && <button type="button" className="btn btn-secondary" onClick={() => { setTerritoriesStatus('idle'); void loadTerritories(); }}>Retry loading territory list</button>}
    {notice && <p className="agent-request-notice" role="status"><CheckCircle2 size={15} />{notice}</p>}
  </section>;
}

function LocationForm({ mode, agent, territoryId, currentDistrict, sectors, cells, villages, sectorId, setSectorId, cellId, setCellId, villageId, setVillageId, venue, setVenue, reason, setReason, saving, error, territoriesStatus, onSubmit, onCancel }) {
  return <form className="agent-relocation-form" onSubmit={onSubmit}>
    <h4>{mode === 'FIRST' ? 'Locate agent in your territory' : 'Request in-territory relocation'}</h4>
    <label>TC district<input value={currentDistrict || agent.territoryId} readOnly /></label>
    <div className="agent-relocation-grid">
      <label>Sector<select value={sectorId} onChange={(event) => { setSectorId(event.target.value); setCellId(''); setVillageId(''); }} required disabled={territoriesStatus !== 'loaded' || !territoryId}><option value="">Choose sector</option>{sectors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Cell<select value={cellId} onChange={(event) => { setCellId(event.target.value); setVillageId(''); }} required disabled={territoriesStatus !== 'loaded' || !sectorId}><option value="">Choose cell</option>{cells.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Village<select value={villageId} onChange={(event) => setVillageId(event.target.value)} required disabled={territoriesStatus !== 'loaded' || !cellId}><option value="">Choose village</option>{villages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    </div>
    <label>Venue<input className="input" maxLength={200} value={venue} onChange={(event) => setVenue(event.target.value)} placeholder="Agent’s business or service location" required /></label>
    {mode === 'REQUEST' && <label className="agent-request-reason">Reason<textarea rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why does the location need to change?" required /></label>}
    {error && <p className="agent-request-error" role="alert">{error}</p>}
    <div className="agent-request-actions"><button className="btn btn-primary" type="submit" disabled={saving || territoriesStatus !== 'loaded' || !sectorId || !cellId || !villageId || !venue.trim()}><Send size={15} />{saving ? 'Submitting…' : mode === 'FIRST' ? 'Save one-time location' : 'Send request to admin'}</button><button className="btn btn-secondary" type="button" onClick={onCancel} disabled={saving}>Cancel</button></div>
  </form>;
}
