import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Activity, Building2, MapPin, Phone, UserRound, Play, Repeat2, Clock3, CheckCircle2, Send } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, LoadingState } from '../components';
import NetworkNotice from '../components/NetworkNotice';
import { MOOLA_PLUS_NETWORK, useNetwork } from '../NetworkContext';
import { useAuth } from '../AuthContext';

const formatDate = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(new Date(value)) : '—';
const formatDateTime = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const money = (value) => value == null ? 'Restricted' : `${Number(value).toLocaleString()} RWF`;

function MoolaAgentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [agent, setAgent] = useState(null);
  const [registrySync, setRegistrySync] = useState(null);
  const [fieldProfile, setFieldProfile] = useState(null);
  const [territories, setTerritories] = useState([]);
  const [territoriesStatus, setTerritoriesStatus] = useState('idle');
  const [locationMode, setLocationMode] = useState('');
  const [locationDraft, setLocationDraft] = useState({ territoryId: '', sectorId: '', cellId: '', villageId: '', venue: '' });
  const [relocationReason, setRelocationReason] = useState('');
  const [savingRelocation, setSavingRelocation] = useState(false);
  const [relocationNotice, setRelocationNotice] = useState('');
  const [transferTargets, setTransferTargets] = useState([]);
  const [transferTargetsLoaded, setTransferTargetsLoaded] = useState(false);
  const [transferFormOpen, setTransferFormOpen] = useState(false);
  const [transferDistrict, setTransferDistrict] = useState('');
  const [transferTc, setTransferTc] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [savingTransfer, setSavingTransfer] = useState(false);
  const [transferNotice, setTransferNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/api/v1/reports/moola-plus/agents/${encodeURIComponent(id)}`);
      setAgent(data.data);
      setRegistrySync({ fetchedAt: data.fetchedAt, stale: Boolean(data.stale) });
      const { data: profile } = await api.get(`/api/v1/visits/moola-plus/agents/${encodeURIComponent(id)}/location`);
      setFieldProfile(profile);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load this Moola Plus agent.');
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (user?.role?.toUpperCase() !== 'TC') return;
    setTerritoriesStatus('loading');
    api.get('/api/v1/territories').then(({ data }) => { setTerritories(data || []); setTerritoriesStatus('loaded'); }).catch((err) => {
      setTerritories([]);
      setTerritoriesStatus('error');
      setError((current) => current || err.response?.data?.error || 'Could not load relocation districts.');
    });
  }, [user?.role]);

  const currentTerritoryId = fieldProfile?.location?.territoryId || territories.find((item) => item.type === 'DISTRICT' && item.name.trim().toLocaleLowerCase() === String(agent?.district || '').trim().toLocaleLowerCase())?.id || '';
  const currentDistrict = fieldProfile?.location?.territory?.name || territories.find((item) => item.id === currentTerritoryId)?.name || agent?.district || '—';
  const assignedTerritoryIds = (user?.assignedTerritories || []).map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean);
  const assignedDistricts = territories.filter((item) => item.type === 'DISTRICT' && item.isActive && assignedTerritoryIds.includes(item.id));
  const sectors = territories.filter((item) => item.type === 'SECTOR' && item.isActive && item.parentId === currentTerritoryId);
  const cells = territories.filter((item) => item.type === 'CELL' && item.isActive && item.parentId === locationDraft.sectorId);
  const villages = territories.filter((item) => item.type === 'VILLAGE' && item.isActive && item.parentId === locationDraft.cellId);
  const findAreaId = (type, parentId, name) => territories.find((item) => item.type === type && item.parentId === parentId && item.name.trim().toLocaleLowerCase() === String(name || '').trim().toLocaleLowerCase())?.id || '';

  const loadLocationTerritories = async () => {
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

  const openLocationForm = (mode) => {
    setError('');
    setRelocationNotice('');
    setRelocationReason('');
    const territoryId = currentTerritoryId;
    const savedLocation = fieldProfile?.location;
    const sameSavedDistrict = savedLocation?.territoryId === territoryId;
    const sectorId = (sameSavedDistrict ? savedLocation?.sectorId : '') || findAreaId('SECTOR', territoryId, savedLocation?.sectorName || agent?.fieldLocation?.sector || agent?.sector);
    const cellId = (sameSavedDistrict && sectorId === savedLocation?.sectorId ? savedLocation?.cellId : '') || findAreaId('CELL', sectorId, savedLocation?.cellName || agent?.fieldLocation?.cell || agent?.cell);
    const villageId = (sameSavedDistrict && cellId === savedLocation?.cellId ? savedLocation?.villageId : '') || findAreaId('VILLAGE', cellId, savedLocation?.villageName || agent?.fieldLocation?.village || agent?.village);
    setLocationDraft({
      territoryId,
      sectorId,
      cellId,
      villageId,
      venue: sameSavedDistrict ? savedLocation?.venue || '' : '',
    });
    setLocationMode(mode);
    void loadLocationTerritories();
  };

  const updateLocationDraft = (field, value) => setLocationDraft((current) => {
    if (field === 'territoryId') return { ...current, territoryId: value, sectorId: '', cellId: '', villageId: '' };
    if (field === 'sectorId') return { ...current, sectorId: value, cellId: '', villageId: '' };
    if (field === 'cellId') return { ...current, cellId: value, villageId: '' };
    return { ...current, [field]: value };
  });

  const submitLocationDetails = async (event) => {
    event.preventDefault();
    if (!locationDraft.territoryId || !locationDraft.sectorId || !locationDraft.cellId || !locationDraft.villageId || !locationDraft.venue.trim()) {
      setError('Choose the district, sector, cell and village, and enter the venue.');
      return;
    }
    setSavingRelocation(true);
    setRelocationNotice('');
    setError('');
    try {
      if (locationMode === 'FIRST') {
        const { data } = await api.patch(`/api/v1/visits/moola-plus/agents/${encodeURIComponent(id)}/location-details`, { ...locationDraft, venue: locationDraft.venue.trim() });
        setFieldProfile((current) => ({ ...current, tcMoveUsed: true, location: { ...current?.location, ...data.location, tcMoveUsed: true } }));
        setRelocationNotice('The one-time in-territory location action is complete. Any further move must be requested from an administrator.');
      } else {
        const { data } = await api.post(`/api/v1/visits/moola-plus/agents/${encodeURIComponent(id)}/relocation-requests`, { ...locationDraft, territoryId: currentTerritoryId, venue: locationDraft.venue.trim(), reason: relocationReason.trim() });
        setFieldProfile((current) => ({ ...current, location: { ...current?.location, pendingRelocation: data } }));
        setRelocationNotice('Location change sent to an administrator for review. The current location remains active until approval.');
      }
      setLocationMode('');
    } catch (err) { setError(err.response?.data?.error || 'Could not save the agent’s location details.'); }
    finally { setSavingRelocation(false); }
  };

  const loadTransferTargets = async () => {
    if (transferTargets.length) return;
    try {
      const { data } = await api.get(`/api/v1/visits/moola-plus/agents/${encodeURIComponent(id)}/transfer-targets`);
      setTransferTargets(data || []);
      setTransferTargetsLoaded(true);
      setTransferDistrict(data?.[0]?.id || '');
      setTransferTc(data?.[0]?.coordinators?.[0]?.id || '');
    } catch (err) { setError(err.response?.data?.error || 'Could not load destination coordinators.'); }
  };

  const submitTransfer = async (event) => {
    event.preventDefault();
    if (!transferDistrict || !transferTc) return;
    setSavingTransfer(true);
    setError('');
    setTransferNotice('');
    try {
      const { data } = await api.post(`/api/v1/visits/moola-plus/agents/${encodeURIComponent(id)}/transfer`, { toTerritoryId: transferDistrict, recipientTcId: transferTc, reason: transferReason.trim() });
      setFieldProfile((current) => ({
        ...current,
        tcMoveUsed: true,
        pendingTransfer: data.status === 'COMPLETED' ? null : data,
        location: data.status === 'COMPLETED' ? { ...current?.location, territoryId: data.toTerritoryId, territory: data.toTerritory, sectorId: null, cellId: null, villageId: null, venue: null, tcLocationDetailsCompletedAt: null, tcMoveUsed: true } : current?.location,
      }));
      setTransferNotice(data.adminReviewRequired
        ? 'Transfer request sent to an administrator. The agent is on hold while it is reviewed.'
        : 'The one-time transfer is complete and the agent is now assigned to the selected TC.');
      setTransferReason('');
      setTransferFormOpen(false);
    } catch (err) { setError(err.response?.data?.error || 'Could not submit the transfer request.'); }
    finally { setSavingTransfer(false); }
  };

  const role = user?.role?.toUpperCase();
  const isTc = role === 'TC';
  const location = fieldProfile?.location;
  const tcMoveUsed = Boolean(fieldProfile?.tcMoveUsed || location?.tcMoveUsed);

  return <div className="page moola-agent-detail-page">
    <PageHeader title={agent?.name || 'Moola Plus agent'} subtitle="DDIN agent profile, transaction activity and field visit history." breadcrumbs={[{ label: 'Agents', href: '/agents' }, { label: agent?.name || 'Moola Plus agent' }]} actions={<div className="flex gap-2"><button className="btn btn-secondary" onClick={() => navigate('/agents')}><ArrowLeft size={16} />Back to agents</button>{isTc && <button className="btn btn-primary" onClick={() => navigate(`/visits/new?externalAgentId=${encodeURIComponent(id)}`)}><Play size={15} />Start visit</button>}</div>} />
    {error && <ErrorState message={error} onRetry={load} />}
    {loading ? <LoadingState message="Loading agent profile…" /> : !error && agent && <>
      <section className="agent-profile-grid network-agent-profile-grid">
        <article className="surface-card agent-profile-card"><div className="agent-identity"><span className="agent-profile-avatar">{(agent.name || 'A').slice(0, 1).toUpperCase()}</span><div><span className="section-kicker">AGENT PROFILE</span><h2>{agent.name || 'Moola Plus agent'}</h2><p>{agent.loginName || 'Login unavailable'}</p></div><span className={`moola-status-pill status-${agent.activityStatus.toLowerCase()}`}>{agent.activityStatus}</span></div>
          <div className="agent-contact-grid"><div><span><Phone size={14} />Phone</span><strong>{agent.phone ? <a className="agent-phone-link" href={`tel:${agent.phone.replace(/[^\d+]/g, '')}`}>{agent.phone}</a> : 'Not provided'}</strong></div><div><span><Building2 size={14} />Agent category</span><strong>{agent.agentCategory || 'Not recorded'}</strong></div><div><span><UserRound size={14} />Business type</span><strong>{agent.businessType || 'Not recorded'}</strong></div><div><span>Gender</span><strong>{agent.gender || 'Not recorded'}</strong></div><div><span>Registered</span><strong>{formatDate(agent.registrationDate)}</strong></div><div><span><Activity size={14} />Reported transactions</span><strong>{Number(agent.reportedDepositCount || 0).toLocaleString()}</strong></div><div><span>Last dated transaction</span><strong>{formatDate(agent.lastTransactionDate)}</strong></div></div>
        </article>
        <article className="surface-card agent-location-card"><div className="detail-panel-heading"><span className="detail-icon gps-icon"><MapPin size={17} /></span><div><h3>Registered territory</h3><p>{[agent.province, currentDistrict, location?.sectorName || agent.fieldLocation?.sector || agent.sector, location?.cellName || agent.fieldLocation?.cell, location?.villageName || agent.fieldLocation?.village].filter(Boolean).join(' · ') || 'Location unavailable'}</p></div></div><div className="agent-coordinate">{location?.venue || agent.fieldLocation?.venue || agent.city || 'Business location not recorded'}</div><div className="agent-location-footer"><span>{location?.locationVerified ? 'Field GPS verified' : 'Field GPS not verified'}</span><span>{agent.city ? `Registry city: ${agent.city}` : currentDistrict}</span></div></article>
      </section>
      <section className="surface-card moola-detail-card moola-field-location-panel">
        <h3><MapPin size={17} />Field location and relocation</h3>
        {location?.locationVerified ? <p className="moola-field-location-status"><CheckCircle2 size={16} /> Verified field GPS · {Number(location.latitude).toFixed(5)}, {Number(location.longitude).toFixed(5)} · {currentDistrict}</p> : <p className="moola-field-location-status"><MapPin size={16} /> {location ? 'Location needs GPS confirmation at the next visit.' : 'No field location is recorded yet. Set the agent’s first location below.'}</p>}
        {location?.pendingRelocation && <div className="request-status-callout"><strong>Location change awaiting administrator review</strong><span>{location.pendingRelocation.destinationPath || `${location.pendingRelocation.fromTerritory?.name || currentDistrict} → ${location.pendingRelocation.toTerritory?.name || currentDistrict}`}{location.pendingRelocation.toVenue ? ` · ${location.pendingRelocation.toVenue}` : ''}</span></div>}
        {fieldProfile?.pendingTransfer && <div className="request-status-callout"><strong>{fieldProfile.pendingTransfer.status === 'ON_HOLD' ? 'Agent on hold for administrator follow-up' : fieldProfile.pendingTransfer.acceptedAt ? 'Transfer accepted · new field location required' : 'Transfer awaiting TC review'}</strong><span>{fieldProfile.pendingTransfer.fromTerritory?.name || currentDistrict} → {fieldProfile.pendingTransfer.toTerritory?.name || 'Destination district'}{fieldProfile.pendingTransfer.reviewNote ? ` · ${fieldProfile.pendingTransfer.reviewNote}` : ''}</span></div>}
        {isTc && territoriesStatus === 'loading' && <p className="moola-data-note">Loading your assigned territory list…</p>}
        {isTc && territoriesStatus === 'loaded' && !assignedDistricts.length && <p className="moola-data-note">No active district is assigned to your account. Ask an administrator to assign your district before recording this agent’s location.</p>}
        {isTc && !location?.pendingRelocation && !fieldProfile?.pendingTransfer && <>
          <div className="request-status-callout"><strong>{tcMoveUsed ? 'The TC one-time move has been used' : 'Choose the TC’s one-time move'}</strong><span>{tcMoveUsed ? 'Submit a relocation or transfer request for administrator review.' : `Locate the agent in ${currentDistrict}, or transfer them to another TC. Either action uses the one-time move.`}</span></div>
          <div className="agent-transfer-section">
            {!locationMode && <button type="button" className="btn btn-secondary" onClick={() => openLocationForm(tcMoveUsed ? 'REQUEST' : 'FIRST')} disabled={territoriesStatus !== 'loaded' || !currentTerritoryId}><MapPin size={15} />{tcMoveUsed ? 'Request relocation within territory' : 'Locate agent within my territory'}</button>}
            {locationMode && <form className="moola-relocation-form" onSubmit={submitLocationDetails}>
              <h4>{locationMode === 'FIRST' ? 'Locate agent in your territory' : 'Request in-territory relocation'}</h4>
              <label>TC district<input className="input" value={currentDistrict} readOnly /></label>
              <div className="agent-relocation-grid">
                <label>Sector<select className="input" value={locationDraft.sectorId} onChange={(event) => updateLocationDraft('sectorId', event.target.value)} required disabled={territoriesStatus !== 'loaded'}><option value="">Choose sector</option>{sectors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label>Cell<select className="input" value={locationDraft.cellId} onChange={(event) => updateLocationDraft('cellId', event.target.value)} required disabled={territoriesStatus !== 'loaded' || !locationDraft.sectorId}><option value="">Choose cell</option>{cells.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label>Village<select className="input" value={locationDraft.villageId} onChange={(event) => setLocationDraft((current) => ({ ...current, villageId: event.target.value }))} required disabled={territoriesStatus !== 'loaded' || !locationDraft.cellId}><option value="">Choose village</option>{villages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              </div>
              <label>Venue<input className="input" value={locationDraft.venue} onChange={(event) => setLocationDraft((current) => ({ ...current, venue: event.target.value }))} maxLength={200} placeholder="Agent’s business or service location" required /></label>
              {locationMode === 'REQUEST' && <label>Reason<textarea className="input" rows={2} maxLength={500} value={relocationReason} onChange={(event) => setRelocationReason(event.target.value)} placeholder="Why does the agent’s location need to change?" required /></label>}
              {territoriesStatus === 'loading' && <p className="moola-data-note">Loading official sectors, cells and villages…</p>}
              {territoriesStatus === 'error' && <button type="button" className="btn btn-secondary" onClick={() => { setTerritoriesStatus('idle'); void loadLocationTerritories(); }}>Retry loading territory list</button>}
              {error && <p className="request-modal-error" role="alert">{error}</p>}
              <div className="agent-request-actions"><button type="submit" className="btn btn-primary" disabled={savingRelocation || territoriesStatus !== 'loaded' || !locationDraft.sectorId || !locationDraft.cellId || !locationDraft.villageId || !locationDraft.venue.trim()}><Send size={15} />{savingRelocation ? 'Submitting…' : locationMode === 'FIRST' ? 'Save one-time location' : 'Send request to admin'}</button><button type="button" className="btn btn-secondary" onClick={() => setLocationMode('')} disabled={savingRelocation}>Cancel</button></div>
            </form>}
          </div>
          <div className="agent-transfer-section">
            {!transferFormOpen && <button type="button" className="btn btn-secondary" onClick={() => { setTransferFormOpen(true); void loadTransferTargets(); }}><Repeat2 size={15} />{tcMoveUsed ? 'Request transfer from administrator' : 'Transfer to another TC'}</button>}
            {transferFormOpen && <form className="moola-relocation-form" onSubmit={submitTransfer}>
              <h4>{tcMoveUsed ? 'Request transfer from administrator' : 'Transfer to another TC'}</h4>
              {!transferTargetsLoaded && <button type="button" className="btn btn-secondary" onClick={() => void loadTransferTargets()} disabled={savingTransfer}>Load transfer destinations</button>}
              {transferTargetsLoaded && !transferTargets.length && <p className="moola-data-note">No active TC is assigned to another district yet.</p>}
              {transferTargets.length > 0 && <>
                <label>Destination district<select className="input" value={transferDistrict} onChange={(event) => { const target = transferTargets.find((item) => item.id === event.target.value); setTransferDistrict(event.target.value); setTransferTc(target?.coordinators?.[0]?.id || ''); }} required><option value="">Choose destination district</option>{transferTargets.map((item) => <option key={item.id} value={item.id}>{item.name}{item.province ? ` · ${item.province}` : ''}</option>)}</select></label>
                <label>Receiving TC<select className="input" value={transferTc} onChange={(event) => setTransferTc(event.target.value)} required><option value="">Choose TC</option>{(transferTargets.find((item) => item.id === transferDistrict)?.coordinators || []).map((tc) => <option key={tc.id} value={tc.id}>{[tc.firstName, tc.lastName].filter(Boolean).join(' ')}</option>)}</select></label>
                <label>Reason <textarea className="input" rows={2} maxLength={500} value={transferReason} onChange={(event) => setTransferReason(event.target.value)} placeholder="Why the agent needs to move" /></label>
                <button type="submit" className="btn btn-primary" disabled={savingTransfer || !transferDistrict || !transferTc}><Repeat2 size={15} />{savingTransfer ? 'Submitting…' : tcMoveUsed ? 'Send transfer request to admin' : 'Transfer agent now'}</button>
              </>}
              <button type="button" className="btn btn-secondary" onClick={() => setTransferFormOpen(false)}>Cancel</button>
            </form>}
          </div>
        </>}
        {relocationNotice && <p className="moola-field-location-status"><CheckCircle2 size={16} />{relocationNotice}</p>}
        {transferNotice && <p className="moola-field-location-status"><CheckCircle2 size={16} />{transferNotice}</p>}
      </section>
      {error && !loading && <p className="request-modal-error" role="alert">{error}</p>}
      <section className="surface-card agent-history-card moola-deposit-history network-transaction-panel">
        <div className="agent-tabs"><span className="active">Transaction activity</span></div>
        <h3><Activity size={17} />Reported deposits by channel</h3>
        <p>{registrySync?.stale ? 'Showing the last successful sync. ' : ''}DDIN report sync: {formatDateTime(registrySync?.fetchedAt)}. The response may contain aggregate counts without transaction dates or individual transaction IDs.</p>
        {agent.depositActivity?.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Bank / channel</th><th>Reported deposits</th><th>Total amount</th></tr></thead><tbody>{agent.depositActivity.map((item) => <tr key={item.bankUsed}><td>{item.bankUsed}</td><td>{Number(item.depositCount || 0).toLocaleString()}</td><td>{money(item.totalDeposited)}</td></tr>)}</tbody></table></div> : <div className="detail-empty">No manual deposits are present in the current DDIN report.</div>}
      </section>
      <section className="surface-card moola-detail-card moola-visit-history">
        <h3><Clock3 size={17} />Recent visits</h3>
        {fieldProfile?.recentVisits?.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Visit</th><th>Date</th><th>Coordinator</th><th>Status</th><th>Metric</th></tr></thead><tbody>{fieldProfile.recentVisits.map((visit) => <tr key={visit.id} onClick={() => navigate(`/visits/${visit.id}`)}><td><strong>{visit.visitId}</strong></td><td>{formatDateTime(visit.visitDate)}</td><td>{[visit.tc?.firstName, visit.tc?.lastName].filter(Boolean).join(' ') || visit.tc?.username || '—'}</td><td>{visit.visitStatus}</td><td>{visit.countsForMetrics ? 'Counted' : 'Follow-up · excluded'}</td></tr>)}</tbody></table></div> : <div className="detail-empty">No visits have been recorded yet.</div>}
      </section>
      <p className="moola-data-note"><Activity size={14} /> Active means a transaction in the last 3 months; Dormant means a past transaction with none in that period; Inactive means no transactions reported. If the DDIN response has no transaction date, an agent with reported deposits is marked Dormant until recent activity can be confirmed.</p>
    </>}
  </div>;
}

export default function MoolaPlusAgentDetail() {
  const { network } = useNetwork();
  return network === MOOLA_PLUS_NETWORK
    ? <MoolaAgentDetail />
    : <NetworkNotice title="Moola Plus agent" description="This profile belongs to the Moola Plus registry." />;
}
