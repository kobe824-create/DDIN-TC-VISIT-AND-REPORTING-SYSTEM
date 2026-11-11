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
  const [districts, setDistricts] = useState([]);
  const [destinationDistrict, setDestinationDistrict] = useState('');
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
    api.get('/api/v1/visits/moola-plus/relocation-districts').then(({ data }) => setDistricts(data || [])).catch((err) => {
      setDistricts([]);
      setError((current) => current || err.response?.data?.error || 'Could not load relocation districts.');
    });
  }, [user?.role]);

  const submitRelocation = async (event) => {
    event.preventDefault();
    if (!destinationDistrict) return;
    setSavingRelocation(true);
    setRelocationNotice('');
    setError('');
    try {
      const { data } = await api.post(`/api/v1/visits/moola-plus/agents/${encodeURIComponent(id)}/relocation-requests`, { territoryId: destinationDistrict, reason: relocationReason.trim() });
      setFieldProfile((current) => ({ ...current, location: { ...current?.location, pendingRelocation: data } }));
      setRelocationNotice('Relocation request sent to an administrator for review.');
      setDestinationDistrict('');
      setRelocationReason('');
    } catch (err) { setError(err.response?.data?.error || 'Could not submit the relocation request.'); }
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
  const currentTerritoryId = location?.territoryId || agent?.fieldLocation?.territoryId || '';
  const currentDistrict = location?.territory?.name || agent?.fieldLocation?.district || agent?.district || '—';

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
        {location?.pendingRelocation && <div className="request-status-callout"><strong>Relocation awaiting administrator review</strong><span>{location.pendingRelocation.fromTerritory?.name || currentDistrict} → {location.pendingRelocation.toTerritory?.name || 'Destination district'}</span></div>}
        {fieldProfile?.pendingTransfer && <div className="request-status-callout"><strong>{fieldProfile.pendingTransfer.status === 'ON_HOLD' ? 'Agent on hold for administrator follow-up' : fieldProfile.pendingTransfer.acceptedAt ? 'Transfer accepted · new field location required' : 'Transfer awaiting TC review'}</strong><span>{fieldProfile.pendingTransfer.fromTerritory?.name || currentDistrict} → {fieldProfile.pendingTransfer.toTerritory?.name || 'Destination district'}{fieldProfile.pendingTransfer.reviewNote ? ` · ${fieldProfile.pendingTransfer.reviewNote}` : ''}</span></div>}
        {isTc && location && !location.pendingRelocation && !fieldProfile?.pendingTransfer && <form className="moola-relocation-form" onSubmit={submitRelocation}>
          <label>Move to an assigned district<select className="input" value={destinationDistrict} onChange={(event) => setDestinationDistrict(event.target.value)}><option value="">Choose destination district</option>{districts.filter((territory) => territory.id !== currentTerritoryId).map((territory) => <option key={territory.id} value={territory.id}>{territory.name}</option>)}</select></label>
          <label>Relocation note <textarea className="input" rows={2} maxLength={500} value={relocationReason} onChange={(event) => setRelocationReason(event.target.value)} placeholder="Why the agent needs to move" /></label>
          <button type="submit" className="btn btn-secondary" disabled={savingRelocation || !destinationDistrict}><Repeat2 size={15} />{savingRelocation ? 'Sending request…' : 'Request relocation'}</button>
        </form>}
        {isTc && !location && <p className="moola-data-note">Complete the agent’s first visit before requesting a district relocation.</p>}
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
