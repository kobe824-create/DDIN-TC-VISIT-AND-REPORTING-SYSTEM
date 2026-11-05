import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Phone, X } from 'lucide-react';
import api from '../api';

const phoneLink = (value) => String(value || '').replace(/[^\d+]/g, '');

export default function AdminAgentRelocation({ agent, onClose, onSaved }) {
  const [territories, setTerritories] = useState([]);
  const [destination, setDestination] = useState({
    territoryId: agent.territoryId || '',
    sectorId: agent.sectorId || '',
    cellId: agent.cellId || '',
    villageId: agent.villageId || '',
  });
  const [reason, setReason] = useState('');
  const [loadingAreas, setLoadingAreas] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get('/api/v1/territories')
      .then(({ data }) => { if (!cancelled) setTerritories(Array.isArray(data) ? data.filter((item) => item.isActive) : []); })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || 'Could not load active districts and areas.'); })
      .finally(() => { if (!cancelled) setLoadingAreas(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => { if (event.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, saving]);

  const districts = useMemo(() => territories.filter((item) => item.type === 'DISTRICT'), [territories]);
  const sectors = useMemo(() => territories.filter((item) => item.type === 'SECTOR' && item.parentId === destination.territoryId), [territories, destination.territoryId]);
  const cells = useMemo(() => territories.filter((item) => item.type === 'CELL' && item.parentId === destination.sectorId), [territories, destination.sectorId]);
  const villages = useMemo(() => territories.filter((item) => item.type === 'VILLAGE' && item.parentId === destination.cellId), [territories, destination.cellId]);
  const updateDestination = (field, value) => {
    setError('');
    setDestination((current) => {
      if (field === 'territoryId') return { territoryId: value, sectorId: '', cellId: '', villageId: '' };
      if (field === 'sectorId') return { ...current, sectorId: value, cellId: '', villageId: '' };
      if (field === 'cellId') return { ...current, cellId: value, villageId: '' };
      return { ...current, [field]: value };
    });
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!destination.territoryId || !destination.sectorId || !destination.cellId || !destination.villageId) {
      setError('Choose a district, sector, cell and village.');
      return;
    }
    if (destination.territoryId === agent.territoryId && destination.sectorId === agent.sectorId && destination.cellId === agent.cellId && destination.villageId === agent.villageId) {
      setError('Choose a different location before saving this relocation.');
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/api/v1/agents/${agent.id}/location`, {
        ...destination,
        reason: reason.trim(),
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not relocate this agent. Check the selected area and try again.');
    } finally { setSaving(false); }
  };

  return <div className="request-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="request-modal admin-relocation-modal" role="dialog" aria-modal="true" aria-labelledby="admin-relocation-title">
      <button type="button" className="request-modal-close" aria-label="Close relocation form" onClick={onClose} disabled={saving}><X size={19} /></button>
      <span className="request-modal-kicker">ADMIN AGENT ACTION</span>
      <h2 id="admin-relocation-title">Relocate {agent.name}</h2>
      <p className="request-modal-intro">Choose the agent’s new area. The old GPS point will be cleared, and the assigned TC will record a fresh one during the next visit.</p>
      <div className="request-agent-summary">
        <div><small>AGENT NUMBER</small><strong>{agent.agentId || '—'}</strong><span>{agent.territory?.name || 'Current district'}{agent.sector?.name ? ` · ${agent.sector.name}` : ''}</span></div>
        <div><small>PHONE NUMBER</small>{agent.phoneNumber ? <a className="request-phone-link" href={`tel:${phoneLink(agent.phoneNumber)}`} onClick={(event) => event.stopPropagation()}><Phone size={16} />{agent.phoneNumber}</a> : <strong className="request-no-phone">No phone number on record</strong>}</div>
      </div>
      <form className="admin-relocation-form" onSubmit={submit}>
        <div className="admin-relocation-fields">
          <label>District<select value={destination.territoryId} onChange={(event) => updateDestination('territoryId', event.target.value)} required disabled={loadingAreas}><option value="">Choose district</option>{districts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Sector<select value={destination.sectorId} onChange={(event) => updateDestination('sectorId', event.target.value)} required disabled={loadingAreas || !destination.territoryId}><option value="">Choose sector</option>{sectors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Cell<select value={destination.cellId} onChange={(event) => updateDestination('cellId', event.target.value)} required disabled={loadingAreas || !destination.sectorId}><option value="">Choose cell</option>{cells.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Village<select value={destination.villageId} onChange={(event) => updateDestination('villageId', event.target.value)} required disabled={loadingAreas || !destination.cellId}><option value="">Choose village</option>{villages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
        {loadingAreas && <p className="admin-relocation-hint">Loading active districts and areas…</p>}
        <label className="admin-relocation-reason">Reason <span>(optional)</span><textarea rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is this agent’s location changing?" /></label>
        <p className="admin-relocation-hint">The agent cannot be checked in until the TC verifies the new location during a visit.</p>
        {error && <p className="request-modal-error" role="alert">{error}</p>}
        <div className="request-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving || loadingAreas}><ArrowRightLeft size={16} />{saving ? 'Saving relocation…' : 'Save relocation'}</button>
        </div>
      </form>
    </section>
  </div>;
}
