import React, { useMemo, useState } from 'react';
import { ArrowRightLeft, MapPin, Send } from 'lucide-react';
import api from '../api';

export default function AdminAgentMoves({ network, agent, onComplete }) {
  const [mode, setMode] = useState('');
  const [territories, setTerritories] = useState([]);
  const [targets, setTargets] = useState([]);
  const [territoryId, setTerritoryId] = useState('');
  const [sectorId, setSectorId] = useState('');
  const [cellId, setCellId] = useState('');
  const [villageId, setVillageId] = useState('');
  const [recipientTcId, setRecipientTcId] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const districts = useMemo(() => territories.filter((item) => item.type === 'DISTRICT' && item.isActive), [territories]);
  const sectors = useMemo(() => territories.filter((item) => item.type === 'SECTOR' && item.isActive && item.parentId === territoryId), [territories, territoryId]);
  const cells = useMemo(() => territories.filter((item) => item.type === 'CELL' && item.isActive && item.parentId === sectorId), [territories, sectorId]);
  const villages = useMemo(() => territories.filter((item) => item.type === 'VILLAGE' && item.isActive && item.parentId === cellId), [territories, cellId]);

  const open = async (nextMode) => {
    setMode((current) => current === nextMode ? '' : nextMode);
    setError('');
    setNotice('');
    setReason('');
    if (territories.length) return;
    setLoading(true);
    try {
      const [territoryResult, targetsResult] = await Promise.all([
        api.get('/api/v1/territories'),
        api.get('/api/v1/agents/transfer-hold-targets'),
      ]);
      setTerritories(territoryResult.data || []);
      setTargets(targetsResult.data || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load districts and coordinators.');
    } finally { setLoading(false); }
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (mode === 'RELOCATE') {
        if (network === 'IREMBO') {
          const { data: fieldAgent } = await api.post(`/api/v1/agents/irembo/${encodeURIComponent(agent.agentId || agent.id)}/field-record`);
          await api.patch(`/api/v1/agents/${encodeURIComponent(fieldAgent.id)}/location`, { territoryId, sectorId, cellId: cellId || undefined, villageId: villageId || undefined, reason: reason.trim() });
        } else {
          await api.post(`/api/v1/visits/moola-plus/agents/${encodeURIComponent(agent.id)}/admin-relocate`, { territoryId, reason: reason.trim() });
        }
        setNotice('Agent relocated. The current and receiving coordinators have been notified.');
      } else {
        const body = { toTerritoryId: territoryId, recipientTcId, reason: reason.trim() };
        let url;
        if (network === 'IREMBO') {
          const { data: fieldAgent } = await api.post(`/api/v1/agents/irembo/${encodeURIComponent(agent.agentId || agent.id)}/field-record`);
          url = `/api/v1/agents/${encodeURIComponent(fieldAgent.id)}/admin-transfer`;
        } else url = `/api/v1/visits/moola-plus/agents/${encodeURIComponent(agent.id)}/admin-transfer`;
        await api.post(url, body);
        setNotice('Transfer sent to the receiving TC. Their acceptance is optional because an administrator routed it.');
      }
      setMode('');
      onComplete?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update this agent’s territory.');
    } finally { setSaving(false); }
  };

  const selectedTarget = targets.find((item) => item.id === territoryId);
  const currentDistrictName = String(agent.fieldLocation?.district || agent.district || '').trim().toLocaleLowerCase();
  return <div className="admin-agent-moves" onClick={(event) => event.stopPropagation()}>
    <div className="admin-agent-move-buttons">
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void open('RELOCATE')}><MapPin size={14} />Relocate</button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void open('TRANSFER')}><ArrowRightLeft size={14} />Transfer</button>
    </div>
    {mode && <form className="admin-agent-move-form" onSubmit={submit}>
      <strong>{mode === 'RELOCATE' ? 'Relocate agent' : 'Transfer agent to a TC'}</strong>
      {loading ? <p>Loading active districts…</p> : <>
        <label>Destination district<select className="input" required value={territoryId} onChange={(event) => { const next = event.target.value; setTerritoryId(next); setSectorId(''); setCellId(''); setVillageId(''); setRecipientTcId(targets.find((item) => item.id === next)?.coordinators?.[0]?.id || ''); }}><option value="">Choose district</option>{(mode === 'TRANSFER' ? targets : districts).filter((item) => item.id !== (agent.localTerritoryId || agent.fieldLocation?.territoryId || agent.territoryId) && item.name.trim().toLocaleLowerCase() !== currentDistrictName).map((item) => <option key={item.id} value={item.id}>{item.name}{item.province ? ` · ${item.province}` : ''}</option>)}</select></label>
        {mode === 'RELOCATE' && network === 'IREMBO' && <>
          <label>Sector<select className="input" required value={sectorId} onChange={(event) => { setSectorId(event.target.value); setCellId(''); setVillageId(''); }}><option value="">Choose sector</option>{sectors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Cell<select className="input" value={cellId} onChange={(event) => { setCellId(event.target.value); setVillageId(''); }} disabled={!sectorId} required><option value="">Choose cell</option>{cells.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Village<select className="input" value={villageId} onChange={(event) => setVillageId(event.target.value)} disabled={!cellId} required><option value="">Choose village</option>{villages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </>}
        {mode === 'TRANSFER' && <label>Receiving TC<select className="input" required value={recipientTcId} onChange={(event) => setRecipientTcId(event.target.value)}><option value="">Choose TC</option>{(selectedTarget?.coordinators || []).map((tc) => <option key={tc.id} value={tc.id}>{[tc.firstName, tc.lastName].filter(Boolean).join(' ')}</option>)}</select></label>}
        <label>Reason <textarea className="input" rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Optional note for the coordinators" /></label>
        <div className="admin-agent-move-actions"><button className="btn btn-primary btn-sm" type="submit" disabled={saving || loading || !territoryId || (mode === 'TRANSFER' && !recipientTcId) || (mode === 'RELOCATE' && network === 'IREMBO' && (!sectorId || !cellId || !villageId))}><Send size={14} />{saving ? 'Saving…' : mode === 'RELOCATE' ? 'Relocate agent' : 'Send transfer'}</button><button className="btn btn-secondary btn-sm" type="button" onClick={() => setMode('')} disabled={saving}>Cancel</button></div>
      </>}
      {error && <p className="admin-agent-move-error" role="alert">{error}</p>}
    </form>}
    {notice && <p className="admin-agent-move-notice" role="status">{notice}</p>}
  </div>;
}
