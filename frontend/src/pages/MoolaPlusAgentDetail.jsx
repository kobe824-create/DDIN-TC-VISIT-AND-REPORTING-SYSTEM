import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Activity, Building2, MapPin, Phone, UserRound, Play, Repeat2, Clock3, CheckCircle2 } from 'lucide-react';
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
  const sectors = territories.filter((item) => item.type === 'SECTOR' && item.isActive && item.parentId === (locationDraft.territoryId || currentTerritoryId));
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
    const sectorId = fieldProfile?.location?.sectorId || findAreaId('SECTOR', currentTerritoryId, fieldProfile?.location?.sectorName || agent?.fieldLocation?.sector || agent?.sector);
    const cellId = fieldProfile?.location?.cellId || findAreaId('CELL', sectorId, fieldProfile?.location?.cellName || agent?.fieldLocation?.cell || agent?.cell);
    const villageId = fieldProfile?.location?.villageId || findAreaId('VILLAGE', cellId, fieldProfile?.location?.villageName || agent?.fieldLocation?.village || agent?.village);
    setLocationDraft({
      territoryId: currentTerritoryId,
      sectorId,
      cellId,
      villageId,
      venue: fieldProfile?.location?.venue || '',
    });
    setLocationMode(mode);
    void loadLocationTerritories();
  };

  const updateLocationDraft = (field, value) => setLocationDraft((current) => {
    if (field === 'sectorId') return { ...current, sectorId: value, cellId: '', villageId: '' };
    if (field === 'cellId') return { ...current, cellId: value, villageId: '' };
    return { ...current, [field]: value };
  });

  const submitLocationDetails = async (event) => {
    event.preventDefault();
    if (!currentTerritoryId || !locationDraft.sectorId || !locationDraft.cellId || !locationDraft.villageId || !locationDraft.venue.trim()) {
      setError('Choose the agent’s sector, cell and village, and enter the venue.');
      return;
    }
    setSavingRelocation(true);
    setRelocationNotice('');
    setError('');
    try {
      if (locationMode === 'INITIAL') {
        const { data } = await api.patch(`/api/v1/visits/moola-plus/agents/${encodeURIComponent(id)}/location-details`, { ...locationDraft, territoryId: currentTerritoryId, venue: locationDraft.venue.trim() });
        setFieldProfile((current) => ({ ...current, location: { ...current?.location, ...data.location } }));
        setRelocationNotice('Location details saved once. Any later change must be sent to an administrator.');
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
      setFieldProfile((current) => ({ ...current, pendingTransfer: data }));
      setTransferNotice('Transfer request sent. The receiving TC will review it and confirm the agent’s location.');
      setTransferReason('');
    } catch (err) { setError(err.response?.data?.error || 'Could not submit the transfer request.'); }
    finally { setSavingTransfer(false); }
  };

  const role = user?.role?.toUpperCase();
  const isTc = role === 'TC';
  const location = fieldProfile?.location;

  return <div className="page moola-agent-detail-page">
    <PageHeader title={agent?.name || 'Moola Plus agent'} subtitle="DDIN agent profile, transaction activity and field visit history." breadcrumbs={[{ label: 'Agents', href: '/agents' }, { label: agent?.name || 'Moola Plus agent' }]} actions={<div className="flex gap-2"><button className="btn btn-secondary" onClick={() => navigate('/agents')}><ArrowLeft size={16} />Back to agents</button>{isTc && <button className="btn btn-primary" onClick={() => navigate(`/visits/new?externalAgentId=${encodeURIComponent(id)}`)}><Play size={15} />Start visit</button>}</div>} />
    {error && <ErrorState message={error} onRetry={load} />}
    {loading ? <LoadingState message="Loading agent profile…" /> : !error && agent && <>
      <section className="agent-profile-grid network-agent-profile-grid">
        <article className="surface-card agent-profile-card"><div className="agent-identity"><span className="agent-profile-avatar">{(agent.name || 'A').slice(0, 1).toUpperCase()}</span><div><span className="section-kicker">AGENT PROFILE</span><h2>{agent.name || 'Moola Plus agent'}</h2><p>{agent.loginName || 'Login unavailable'}</p></div><span className={`moola-status-pill status-${agent.activityStatus.toLowerCase()}`}>{agent.activityStatus}</span></div>
          <div className="agent-contact-grid"><div><span><Phone size={14} />Phone</span><strong>{agent.phone ? <a className="agent-phone-link" href={`tel:${agent.phone.replace(/[^\d+]/g, '')}`}>{agent.phone}</a> : 'Not provided'}</strong></div><div><span><Building2 size={14} />Agent category</span><strong>{agent.agentCategory || 'Not recorded'}</strong></div><div><span><UserRound size={14} />Business type</span><strong>{agent.businessType || 'Not recorded'}</strong></div><div><span>Gender</span><strong>{agent.gender || 'Not recorded'}</strong></div><div><span>Registered</span><strong>{formatDate(agent.registrationDate)}</strong></div><div><span><Activity size={14} />Reported transactions</span><strong>{Number(agent.reportedDepositCount || 0).toLocaleString()}</strong></div></div>
        </article>
        <article className="surface-card agent-location-card"><div className="detail-panel-heading"><span className="detail-icon gps-icon"><MapPin size={17} /></span><div><h3>Registered territory</h3><p>{[agent.province, currentDistrict, location?.sectorName || agent.fieldLocation?.sector || agent.sector, location?.cellName || agent.fieldLocation?.cell, location?.villageName || agent.fieldLocation?.village].filter(Boolean).join(' · ') || 'Location unavailable'}</p></div></div><div className="agent-coordinate">{location?.venue || agent.fieldLocation?.venue || agent.city || 'Business location not recorded'}</div><div className="agent-location-footer"><span>{location?.locationVerified ? 'Field GPS verified' : 'Field GPS not verified'}</span><span>{agent.city ? `Registry city: ${agent.city}` : currentDistrict}</span></div></article>
      </section>
      <section className="surface-card moola-detail-card moola-field-location-panel">
        <h3><MapPin size={17} />Field location and relocation</h3>
        {location?.locationVerified ? <p className="moola-field-location-status"><CheckCircle2 size={16} /> Verified field GPS · {Number(location.latitude).toFixed(5)}, {Number(location.longitude).toFixed(5)} · {currentDistrict}</p> : <p className="moola-field-location-status"><MapPin size={16} /> {location ? 'Location needs GPS confirmation at the next visit.' : 'The agent’s first visit will record the field location.'}</p>}
        {location?.pendingRelocation && <div className="request-status-callout"><strong>Location change awaiting administrator review</strong><span>{location.pendingRelocation.destinationPath || `${location.pendingRelocation.fromTerritory?.name || currentDistrict} → ${location.pendingRelocation.toTerritory?.name || currentDistrict}`}{location.pendingRelocation.toVenue ? ` · ${location.pendingRelocation.toVenue}` : ''}</span></div>}
        {fieldProfile?.pendingTransfer && <div className="request-status-callout"><strong>{fieldProfile.pendingTransfer.status === 'ON_HOLD' ? 'Agent on hold for administrator follow-up' : fieldProfile.pendingTransfer.acceptedAt ? 'Transfer accepted · new field location required' : 'Transfer awaiting TC review'}</strong><span>{fieldProfile.pendingTransfer.fromTerritory?.name || currentDistrict} → {fieldProfile.pendingTransfer.toTerritory?.name || 'Destination district'}{fieldProfile.pendingTransfer.reviewNote ? ` · ${fieldProfile.pendingTransfer.reviewNote}` : ''}</span></div>}
        {isTc && territoriesStatus === 'loading' && <p className="moola-data-note">Loading your assigned territory list…</p>}
        {isTc && territoriesStatus === 'loaded' && !currentTerritoryId && <p className="moola-data-note">This agent’s district is not available in your assigned territories. Ask an administrator to confirm the district assignment.</p>}
        {isTc && !location?.pendingRelocation && !fieldProfile?.pendingTransfer && <>
          {!location?.tcLocationDetailsCompletedAt ? <>
            <div className="request-status-callout"><strong>Complete the agent’s location once</strong><span>Fill in the sector, cell, village and venue in {currentDistrict}. Later corrections or moves go to an administrator.</span></div>
            {!locationMode && <button type="button" className="btn btn-secondary" onClick={() => openLocationForm('INITIAL')} disabled={!currentTerritoryId}><MapPin size={15} />Add location details</button>}
          </> : <>
            <div className="request-status-callout"><strong>One-time location details are saved</strong><span>Request administrator approval for any later change inside {currentDistrict}. Use Transfer for another district.</span></div>
            {!locationMode && <button type="button" className="btn btn-secondary" onClick={() => openLocationForm('REQUEST')}><MapPin size={15} />Request location change</button>}
          </>}
          {locationMode && <form className="moola-relocation-form" onSubmit={submitLocationDetails}>
            <h4>{locationMode === 'INITIAL' ? 'Complete agent location details' : 'Request an administrator-approved change'}</h4>
            <label>District<input className="input" value={currentDistrict} readOnly /></label>
            <div className="agent-relocation-grid">
              <label>Sector<select className="input" value={locationDraft.sectorId} onChange={(event) => updateLocationDraft('sectorId', event.target.value)} required disabled={territoriesStatus !== 'loaded'}><option value="">Choose sector</option>{sectors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label>Cell<select className="input" value={locationDraft.cellId} onChange={(event) => updateLocationDraft('cellId', event.target.value)} required disabled={territoriesStatus !== 'loaded' || !locationDraft.sectorId}><option value="">Choose cell</option>{cells.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label>Village<select className="input" value={locationDraft.villageId} onChange={(event) => updateLocationDraft('villageId', event.target.value)} required disabled={territoriesStatus !== 'loaded' || !locationDraft.cellId}><option value="">Choose village</option>{villages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            </div>
            <label>Venue<input className="input" value={locationDraft.venue} onChange={(event) => updateLocationDraft('venue', event.target.value)} maxLength={200} placeholder="Agent’s business or service location" required /></label>
            {locationMode === 'REQUEST' && <label>Reason<textarea className="input" rows={2} maxLength={500} value={relocationReason} onChange={(event) => setRelocationReason(event.target.value)} placeholder="Why does the agent’s location need to change?" /></label>}
            {territoriesStatus === 'loading' && <p className="moola-data-note">Loading official districts, sectors, cells and villages…</p>}
            {territoriesStatus === 'error' && <button type="button" className="btn btn-secondary" onClick={() => { setTerritoriesStatus('idle'); void loadLocationTerritories(); }}>Retry loading territory list</button>}
            {error && <p className="request-modal-error" role="alert">{error}</p>}
            <div className="agent-request-actions"><button type="submit" className="btn btn-primary" disabled={savingRelocation || territoriesStatus !== 'loaded' || !locationDraft.sectorId || !locationDraft.cellId || !locationDraft.villageId || !locationDraft.venue.trim()}><Send size={15} />{savingRelocation ? 'Saving…' : locationMode === 'INITIAL' ? 'Save location once' : 'Send request to admin'}</button><button type="button" className="btn btn-secondary" onClick={() => setLocationMode('')} disabled={savingRelocation}>Cancel</button></div>
          </form>}
        </>}
        {isTc && !fieldProfile?.pendingTransfer && !location?.pendingRelocation && <form className="moola-relocation-form" onSubmit={submitTransfer}>
          <h4>Transfer to another TC</h4>
          {!transferTargetsLoaded && <button type="button" className="btn btn-secondary" onClick={() => void loadTransferTargets()} disabled={savingTransfer}>Choose a transfer destination</button>}
          {transferTargetsLoaded && !transferTargets.length && <p className="moola-data-note">No active TC is assigned to another district yet.</p>}
          {transferTargets.length > 0 && <>
            <label>Destination district<select className="input" value={transferDistrict} onChange={(event) => { const target = transferTargets.find((item) => item.id === event.target.value); setTransferDistrict(event.target.value); setTransferTc(target?.coordinators?.[0]?.id || ''); }} required><option value="">Choose destination district</option>{transferTargets.map((item) => <option key={item.id} value={item.id}>{item.name}{item.province ? ` · ${item.province}` : ''}</option>)}</select></label>
            <label>Receiving TC<select className="input" value={transferTc} onChange={(event) => setTransferTc(event.target.value)} required><option value="">Choose TC</option>{(transferTargets.find((item) => item.id === transferDistrict)?.coordinators || []).map((tc) => <option key={tc.id} value={tc.id}>{[tc.firstName, tc.lastName].filter(Boolean).join(' ')}</option>)}</select></label>
            <label>Reason <textarea className="input" rows={2} maxLength={500} value={transferReason} onChange={(event) => setTransferReason(event.target.value)} placeholder="Why the agent needs to move" /></label>
            <button type="submit" className="btn btn-primary" disabled={savingTransfer || !transferDistrict || !transferTc}><Repeat2 size={15} />{savingTransfer ? 'Sending request…' : 'Request transfer'}</button>
          </>}
        </form>}
        {relocationNotice && <p className="moola-field-location-status"><CheckCircle2 size={16} />{relocationNotice}</p>}
        {transferNotice && <p className="moola-field-location-status"><CheckCircle2 size={16} />{transferNotice}</p>}
      </section>
      {error && !loading && <p className="request-modal-error" role="alert">{error}</p>}
      <section className="surface-card agent-history-card moola-deposit-history network-transaction-panel">
        <div className="agent-tabs"><span className="active">Transaction activity</span></div>
        <h3><Activity size={17} />Reported deposits by channel</h3>
        <p>{registrySync?.stale ? 'Showing the last successful sync. ' : ''}DDIN report sync: {formatDateTime(registrySync?.fetchedAt)}. The API provides aggregate counts and amounts by bank, without transaction dates or individual transaction IDs.</p>
        {agent.depositActivity?.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Bank / channel</th><th>Reported deposits</th><th>Total amount</th></tr></thead><tbody>{agent.depositActivity.map((item) => <tr key={item.bankUsed}><td>{item.bankUsed}</td><td>{Number(item.depositCount || 0).toLocaleString()}</td><td>{money(item.totalDeposited)}</td></tr>)}</tbody></table></div> : <div className="detail-empty">No manual deposits are present in the current DDIN report.</div>}
      </section>
      <section className="surface-card moola-detail-card moola-visit-history">
        <h3><Clock3 size={17} />Recent visits</h3>
        {fieldProfile?.recentVisits?.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Visit</th><th>Date</th><th>Coordinator</th><th>Status</th><th>Metric</th></tr></thead><tbody>{fieldProfile.recentVisits.map((visit) => <tr key={visit.id} onClick={() => navigate(`/visits/${visit.id}`)}><td><strong>{visit.visitId}</strong></td><td>{formatDateTime(visit.visitDate)}</td><td>{[visit.tc?.firstName, visit.tc?.lastName].filter(Boolean).join(' ') || visit.tc?.username || '—'}</td><td>{visit.visitStatus}</td><td>{visit.countsForMetrics ? 'Counted' : 'Follow-up · excluded'}</td></tr>)}</tbody></table></div> : <div className="detail-empty">No visits have been recorded yet.</div>}
      </section>
      <p className="moola-data-note"><Activity size={14} /> Activity bands: Active 80+, Transacting 30–79, Dormant 1–29, Inactive 0. The current API count is manual deposits, not all monthly agent transactions.</p>
    </>}
  </div>;
}

export default function MoolaPlusAgentDetail() {
  const { network } = useNetwork();
  return network === MOOLA_PLUS_NETWORK
    ? <MoolaAgentDetail />
    : <NetworkNotice title="Moola Plus agent" description="This profile belongs to the Moola Plus registry." />;
}
