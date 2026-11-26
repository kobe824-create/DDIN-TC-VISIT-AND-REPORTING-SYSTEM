import React, { useMemo, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, MapPin, Send } from 'lucide-react';
import api from '../api';

export default function AgentActions({ agent, onAgentChange }) {
  const [territories, setTerritories] = useState([]);
  const [territoriesStatus, setTerritoriesStatus] = useState('idle');
  const [mode, setMode] = useState('');
  const [territoryId, setTerritoryId] = useState(agent.territoryId || '');
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

  // The TC-scoped territories endpoint is authoritative. AuthContext may hold
  // assignments from the previous login, so intersecting with that cache can
  // hide districts assigned since then.
  const districts = useMemo(() => [...new Map(territories.filter((item) => item.type === 'DISTRICT' && item.isActive).map((item) => [item.id, item])).values()], [territories]);
  const sectors = useMemo(() => territories.filter((item) => item.type === 'SECTOR' && item.isActive && item.parentId === territoryId), [territories, territoryId]);
  const cells = useMemo(() => territories.filter((item) => item.type === 'CELL' && item.isActive && item.parentId === sectorId), [territories, sectorId]);
  const villages = useMemo(() => territories.filter((item) => item.type === 'VILLAGE' && item.isActive && item.parentId === cellId), [territories, cellId]);
  const activeTransfer = agent.transfers?.find((item) => item.status === 'PENDING');
  const hasSavedLocationDetails = Boolean(agent.tcLocationDetailsCompletedAt);
  const tcMoveUsed = Boolean(agent.tcMoveUsed || agent.tcRelocationUsed);

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

  const openLocationForm = (nextMode) => {
    if (nextMode === 'REQUEST' && tcMoveUsed) {
      setError('This agent has already had a TC move. Ask an administrator to handle any further transfer or relocation.');
      return;
    }
    setMode(nextMode);
    setError('');
    setNotice('');
    setReason('');
    if (nextMode === 'INITIAL') setTerritoryId(agent.territoryId || '');
    void loadTerritories();
  };

  const submitLocation = async (event) => {
    event.preventDefault();
    setError('');
    setNotice('');
    if (mode === 'REQUEST' && tcMoveUsed) {
      setError('This agent has already had a TC move. Ask an administrator to handle any further transfer or relocation.');
      return;
    }
    if (!territoryId || !sectorId || !cellId || !villageId || !venue.trim()) {
      setError('Choose the agent’s sector, cell and village, and enter the venue.');
      return;
    }
    setSaving(true);
    try {
      if (mode === 'INITIAL') {
        const { data } = await api.patch(`/api/v1/agents/${encodeURIComponent(agent.id)}/location-details`, {
          territoryId, sectorId, cellId, villageId, venue: venue.trim(),
        });
        onAgentChange?.({ ...agent, ...data });
        setNotice('Location details saved. Any later change must be sent to an administrator.');
      } else {
        const { data } = await api.post(`/api/v1/agents/${encodeURIComponent(agent.id)}/relocation-requests`, {
          territoryId, sectorId, cellId, villageId, venue: venue.trim(), reason: reason.trim(),
        });
        const targetDistrict = districts.find((item) => item.id === data.toTerritoryId);
        const request = {
          ...data,
          toTerritory: targetDistrict,
          destinationPath: [targetDistrict?.name || currentDistrict, sectors.find((item) => item.id === sectorId)?.name, cells.find((item) => item.id === cellId)?.name, villages.find((item) => item.id === villageId)?.name].filter(Boolean).join(' · '),
          destinationVenue: venue.trim(),
        };
        setRelocation(request);
        onAgentChange?.({ ...agent, relocationRequests: [request] });
        setNotice('Location change sent to an administrator for review. The current location remains active until approval.');
      }
      setMode('');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the agent’s location details.');
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
    if (tcMoveUsed) {
      setError('This agent has already had a TC move. Ask an administrator to handle any further transfer or relocation.');
      return;
    }
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
    if (tcMoveUsed) { setError('This agent has already had a TC move. Ask an administrator to handle any further transfer or relocation.'); return; }
    if (!transferTerritoryId || !recipientTcId) { setError('Choose a destination district and coordinator.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post(`/api/v1/agents/${encodeURIComponent(agent.id)}/transfer`, { toTerritoryId: transferTerritoryId, recipientTcId, reason: transferReason.trim() });
      onAgentChange?.({ ...agent, transfers: [...(agent.transfers || []), data] });
      setNotice('Transfer request sent. The receiving TC will call the agent and confirm the move.');
      setTransferOpen(false);
    } catch (err) { setError(err.response?.data?.error || 'Could not send the transfer request.'); }
    finally { setSaving(false); }
  };

  const currentTransfer = activeTransfer?.toTerritory?.name || 'another TC’s district';
  const currentDistrict = agent.territory?.name || districts.find((item) => item.id === agent.territoryId)?.name || 'Current district';
  return <section className="surface-card agent-request-card">
    <div className="detail-panel-heading"><span className="detail-icon gps-icon"><ArrowRightLeft size={17} /></span><div><h3>Agent location and moves</h3><p>Complete the location details once. Later changes require administrator review.</p></div></div>

    {relocation ? <div className="agent-request-status" role="status"><strong>Location change awaiting administrator review</strong><span>{relocation.destinationPath || relocation.toTerritory?.name ? `Destination: ${relocation.destinationPath || relocation.toTerritory?.name}${relocation.destinationVenue || relocation.toVenue ? ` · ${relocation.destinationVenue || relocation.toVenue}` : ''} · ` : ''}Requested {relocation.requestedAt ? new Date(relocation.requestedAt).toLocaleDateString() : 'just now'} · the saved location stays active until approval.</span></div>
      : activeTransfer ? <div className="agent-request-status"><strong>{activeTransfer.acceptedAt ? 'Transfer accepted — record the new location before visiting' : `Transfer request pending in ${currentTransfer}`}</strong><span>{activeTransfer.acceptedAt ? 'Open Start visit to capture the agent’s current GPS and village.' : 'The agent remains assigned to this district until the receiving TC reviews the request.'}</span></div>
        : !hasSavedLocationDetails ? <>
          <div className="agent-request-status"><strong>Current district: {currentDistrict}</strong><span>Fill in the sector, cell, village and venue. This save is available once; later corrections go to an administrator.</span></div>
          {mode !== 'INITIAL' && <button type="button" className="agent-transfer-toggle" onClick={() => openLocationForm('INITIAL')}><MapPin size={15} />{tcMoveUsed ? 'Complete missing location details' : 'Relocate within my territory'}</button>}
          {mode === 'INITIAL' && <LocationForm {...{ mode, agent, districts, territoryId, setTerritoryId, sectors, cells, villages, sectorId, setSectorId, cellId, setCellId, villageId, setVillageId, venue, setVenue, reason, setReason, saving, error, territoriesStatus, onSubmit: submitLocation, onCancel: () => setMode('') }} />}
        </> : <>
          <div className="agent-request-status"><strong>Location details saved once</strong><span>A TC can request one administrator-reviewed relocation to any district assigned to their account. A transfer is for a district assigned to another TC.</span></div>
          {tcMoveUsed ? <div className="agent-request-status"><strong>The TC move allowance has been used</strong><span>Further transfers or in-territory relocations must be handled by an administrator.</span></div> : <>
            {mode !== 'REQUEST' && <button type="button" className="agent-transfer-toggle" onClick={() => openLocationForm('REQUEST')}><MapPin size={15} />Relocate within my territory</button>}
            {mode === 'REQUEST' && <LocationForm {...{ mode, agent, districts, territoryId, setTerritoryId, sectors, cells, villages, sectorId, setSectorId, cellId, setCellId, villageId, setVillageId, venue, setVenue, reason, setReason, saving, error, territoriesStatus, onSubmit: submitLocation, onCancel: () => setMode('') }} />}
          </>}
        </>}

    <div className="agent-transfer-section">
      {activeTransfer || relocation || tcMoveUsed ? null : <>
        <button type="button" className="agent-transfer-toggle" onClick={openTransfer}><ArrowRightLeft size={15} />{transferOpen ? 'Close transfer request' : 'Transfer to another TC’s district'}</button>
        {transferOpen && <form className="agent-relocation-form" onSubmit={requestTransfer}>
          <label>Destination district<select value={transferTerritoryId} onChange={(event) => { const target = transferTargets.find((item) => item.id === event.target.value); setTransferTerritoryId(event.target.value); setRecipientTcId(target?.coordinators?.[0]?.id || ''); }} required disabled={transferTargetsStatus !== 'loaded' || !transferTargets.length}><option value="">{transferTargetsStatus === 'loading' ? 'Loading districts…' : 'Choose district'}</option>{transferTargets.map((item) => <option key={item.id} value={item.id}>{item.name}{item.province ? ` — ${item.province}` : ''}</option>)}</select></label>
          <label>Receiving TC<select value={recipientTcId} onChange={(event) => setRecipientTcId(event.target.value)} required disabled={transferTargetsStatus !== 'loaded' || !transferTargets.length}><option value="">{transferTargetsStatus === 'loading' ? 'Loading coordinators…' : 'Choose coordinator'}</option>{(transferTargets.find((item) => item.id === transferTerritoryId)?.coordinators || []).map((tc) => <option key={tc.id} value={tc.id}>{[tc.firstName, tc.lastName].filter(Boolean).join(' ')}</option>)}</select></label>
          <label className="agent-request-reason">Reason<textarea rows={2} maxLength={500} value={transferReason} onChange={(event) => setTransferReason(event.target.value)} placeholder="Where the agent moved, if known" /></label>
          {transferTargetsStatus === 'loading' && <p role="status">Loading available districts and coordinators…</p>}
          {transferTargetsStatus === 'loaded' && !transferTargets.length && <p role="status">No active TC is assigned to another district yet. Ask an administrator to assign a TC to the destination district.</p>}
          {transferTargetsStatus === 'error' && <button className="btn btn-secondary" type="button" onClick={() => { setTransferTargetsStatus('idle'); void loadTransferTargets(); }}>Retry loading destinations</button>}
          <button className="btn btn-primary" type="submit" disabled={saving || transferTargetsStatus !== 'loaded' || !transferTargets.length || !transferTerritoryId || !recipientTcId}><Send size={15} />{saving ? 'Sending…' : 'Send transfer for TC review'}</button>
        </form>}
      </>}
    </div>
    {territoriesStatus === 'loading' && mode && <p className="agent-request-status" role="status">Loading the official territory list…</p>}
    {territoriesStatus === 'error' && mode && <button type="button" className="btn btn-secondary" onClick={() => { setTerritoriesStatus('idle'); void loadTerritories(); }}>Retry loading territory list</button>}
    {notice && <p className="agent-request-notice" role="status"><CheckCircle2 size={15} />{notice}</p>}
  </section>;
}

function LocationForm({ mode, agent, districts, territoryId, setTerritoryId, sectors, cells, villages, sectorId, setSectorId, cellId, setCellId, villageId, setVillageId, venue, setVenue, reason, setReason, saving, error, territoriesStatus, onSubmit, onCancel }) {
  return <form className="agent-relocation-form" onSubmit={onSubmit}>
    <h4>{mode === 'INITIAL' ? 'Complete location details' : 'Request an administrator-approved change'}</h4>
    <label>District<select value={territoryId} onChange={(event) => { setTerritoryId(event.target.value); setSectorId(''); setCellId(''); setVillageId(''); }} required disabled={territoriesStatus !== 'loaded' || (mode === 'INITIAL' && Boolean(agent.tcMoveUsed || agent.tcRelocationUsed))}><option value="">Choose an assigned district</option>{districts.map((item) => <option key={item.id} value={item.id}>{item.name}{item.parentName ? ` · ${item.parentName}` : ''}</option>)}</select></label>
    <div className="agent-relocation-grid">
      <label>Sector<select value={sectorId} onChange={(event) => { setSectorId(event.target.value); setCellId(''); setVillageId(''); }} required disabled={territoriesStatus !== 'loaded'}><option value="">Choose sector</option>{sectors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Cell<select value={cellId} onChange={(event) => { setCellId(event.target.value); setVillageId(''); }} required disabled={territoriesStatus !== 'loaded' || !sectorId}><option value="">Choose cell</option>{cells.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Village<select value={villageId} onChange={(event) => setVillageId(event.target.value)} required disabled={territoriesStatus !== 'loaded' || !cellId}><option value="">Choose village</option>{villages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    </div>
    <label>Venue<input className="input" maxLength={200} value={venue} onChange={(event) => setVenue(event.target.value)} placeholder="Agent’s business or service location" required /></label>
    {mode === 'REQUEST' && <label className="agent-request-reason">Reason<textarea rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why does the location need to change?" /></label>}
    {error && <p className="agent-request-error" role="alert">{error}</p>}
    <div className="agent-request-actions"><button className="btn btn-primary" type="submit" disabled={saving || territoriesStatus !== 'loaded' || !sectorId || !cellId || !villageId || !venue.trim()}><Send size={15} />{saving ? (mode === 'INITIAL' ? 'Saving…' : 'Sending request…') : mode === 'INITIAL' ? 'Save location once' : 'Send request to admin'}</button><button className="btn btn-secondary" type="button" onClick={onCancel} disabled={saving}>Cancel</button></div>
  </form>;
}
