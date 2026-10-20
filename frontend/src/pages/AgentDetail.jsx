import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Building2, Clock3, Edit3, IdCard, MapPin, Phone, Play, RotateCw, UsersRound } from 'lucide-react';
import { useAuth } from '../AuthContext';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, ListPagination, LoadingState, StatusBadge } from '../components';

const dateTime = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';

export default function AgentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [agent, setAgent] = useState(null);
  const [visits, setVisits] = useState([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPages, setHistoryPages] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(25);
  const [locations, setLocations] = useState([]);
  const [locationTotal, setLocationTotal] = useState(0);
  const [locationPages, setLocationPages] = useState(0);
  const [locationPage, setLocationPage] = useState(1);
  const [locationPageSize, setLocationPageSize] = useState(25);
  const [tab, setTab] = useState('visits');
  const [loading, setLoading] = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [error, setError] = useState('');

  const loadAgent = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/api/v1/agents/${id}`);
      setAgent(data);
    } catch (err) { setError(err.response?.data?.error || 'Could not load this agent.'); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { loadAgent(); }, [loadAgent]);
  useEffect(() => {
    if (!agent) return;
    let active = true;
    const loadTab = async () => {
      setTabLoading(true);
      try {
        if (tab === 'visits') {
          const { data } = await api.get('/api/v1/visits', { params: { agentId: id, page: historyPage, limit: historyPageSize } });
          if (active) {
            setVisits(data.data || []);
            setHistoryTotal(data.meta?.total ?? data.data?.length ?? 0);
            setHistoryPages(data.meta?.pages ?? 0);
            setHistoryPage(data.meta?.page ?? historyPage);
          }
        } else {
          const { data } = await api.get(`/api/v1/agents/${id}/location-history`, { params: { page: locationPage, limit: locationPageSize } });
          if (active) {
            setLocations(data.data || []);
            setLocationTotal(data.meta?.total ?? data.data?.length ?? 0);
            setLocationPages(data.meta?.pages ?? 0);
            setLocationPage(data.meta?.page ?? locationPage);
          }
        }
      } catch (err) { if (active) setError(err.response?.data?.error || 'Could not load this history.'); }
      finally { if (active) setTabLoading(false); }
    };
    loadTab();
    return () => { active = false; };
  }, [agent, id, tab, historyPage, historyPageSize, locationPage, locationPageSize]);

  useEffect(() => {
    const lastPage = Math.max(locationPages, 1);
    if (locationPage > lastPage) setLocationPage(lastPage);
  }, [locationPage, locationPages]);

  if (loading) return <LoadingState type="detail" />;
  if (error && !agent) return <ErrorState message={error} onRetry={loadAgent} />;
  if (!agent) return null;
  const role = user?.role?.toUpperCase();
  const canEdit = ['ADMIN', 'MANAGER'].includes(role);
  const canVisit = role === 'TC';
  const championName = [agent.champion?.firstName, agent.champion?.lastName].filter(Boolean).join(' ') || 'Not assigned';

  return <div className="agent-detail-page page">
    <PageHeader title={agent.name} subtitle={`${agent.agentId} · ${agent.businessName || 'Independent agent'}`} breadcrumbs={[{ label: 'Agents', href: '/agents' }, { label: agent.name }]} actions={<div className="flex gap-2">{canEdit && <button className="btn btn-secondary" onClick={() => navigate(`/agents/${id}/edit`)}><Edit3 size={15} />Edit agent</button>}{canVisit && <button className="btn btn-primary" onClick={() => navigate(`/visits/new?agentId=${id}`)}><Play size={15} />Start visit</button>}</div>} />
    {error && <div className="alert alert-warning" role="status">{error}</div>}
    <section className="agent-profile-grid">
      <article className="surface-card agent-profile-card"><div className="agent-identity"><span className="agent-profile-avatar">{(agent.name || 'A').slice(0, 1).toUpperCase()}</span><div><span className="section-kicker">AGENT PROFILE</span><h2>{agent.name}</h2><p>{agent.agentId}</p></div><StatusBadge status={agent.status} /></div><div className="agent-contact-grid"><div><span><Phone size={14} />Phone</span><strong>{agent.phoneNumber ? <a className="agent-phone-link" href={`tel:${agent.phoneNumber.replace(/[^\d+]/g, '')}`}>{agent.phoneNumber}</a> : 'Not provided'}</strong></div><div><span><Building2 size={14} />Business</span><strong>{agent.businessName || 'Independent agent'}</strong></div><div><span><MapPin size={14} />Address</span><strong>{agent.address || 'Not provided'}</strong></div><div><span><RotateCw size={14} />Champion</span><strong>{championName}</strong></div></div></article>
      <article className="surface-card agent-location-card"><div className="detail-panel-heading"><span className="detail-icon gps-icon"><MapPin size={17} /></span><div><h3>Registered location</h3><p>{agent.territory?.name || 'District unavailable'}{agent.sector?.name ? ` · ${agent.sector.name}` : ''}</p></div></div><div className="agent-coordinate">{agent.registeredLatitude == null || agent.registeredLongitude == null ? 'Not captured yet' : <>{Number(agent.registeredLatitude).toFixed(6)}<span>,</span> {Number(agent.registeredLongitude).toFixed(6)}</>}</div><div className="agent-location-footer"><StatusBadge status={agent.locationVerified ? 'verified' : 'low_accuracy'} /><span>{agent.gpsAccuracy ? `±${Math.round(agent.gpsAccuracy)} m accuracy` : 'Accuracy not recorded'}</span></div></article>
      {role === 'ADMIN' && agent.personalDetails && <article className="surface-card agent-profile-card"><div className="detail-panel-heading"><span className="detail-icon report-icon"><IdCard size={17} /></span><div><h3>Personal details</h3><p>Visible to administrators only</p></div></div><div className="agent-contact-grid"><div><span><IdCard size={14} />National ID</span><strong>{agent.personalDetails.nationalId || 'Not provided'}</strong></div><div><span><UsersRound size={14} />Next of kin</span><strong>{agent.personalDetails.nextOfKinName || 'Not provided'}</strong></div><div><span><Phone size={14} />Next-of-kin phone</span><strong>{agent.personalDetails.nextOfKinPhone || 'Not provided'}</strong></div></div></article>}
    </section>
    <section className="surface-card agent-history-card"><div className="agent-tabs" role="tablist"><button role="tab" aria-selected={tab === 'visits'} className={tab === 'visits' ? 'active' : ''} onClick={() => setTab('visits')}>Visit history <span>{historyTotal.toLocaleString()}</span></button><button role="tab" aria-selected={tab === 'locations'} className={tab === 'locations' ? 'active' : ''} onClick={() => setTab('locations')}>Location history <span>{locationTotal.toLocaleString()}</span></button></div>
      {tabLoading ? <LoadingState message="Loading history…" /> : tab === 'visits' ? visits.length ? <><div className="table-scroll"><table className="data-table agent-history-table"><thead><tr><th>Visit</th><th>Coordinator</th><th>GPS status</th><th>Distance</th><th>Visit status</th><th>Date</th></tr></thead><tbody>{visits.map((visit) => <tr key={visit.id} onClick={() => navigate(`/visits/${visit.id}`)}><td><strong>{visit.visitId}</strong></td><td>{[visit.tc?.firstName, visit.tc?.lastName].filter(Boolean).join(' ') || visit.tc?.username || '—'}</td><td><StatusBadge status={visit.locationStatus} /></td><td>{Math.round(visit.distanceMeters || 0)} m</td><td><StatusBadge status={visit.visitStatus} /></td><td>{dateTime(visit.visitDate || visit.checkInTime)}</td></tr>)}</tbody></table></div><ListPagination page={historyPage} pages={historyPages} total={historyTotal} pageSize={historyPageSize} onPageChange={setHistoryPage} onPageSizeChange={(value) => { setHistoryPageSize(value); setHistoryPage(1); }} /></> : <div className="detail-empty">No visit history is available for this agent.</div> : locationTotal ? <><div className="location-history-list">{locations.map((location) => <div className="location-history-row" key={location.id}><span className="location-history-icon"><MapPin size={15} /></span><div><strong>{Number(location.latitude).toFixed(6)}, {Number(location.longitude).toFixed(6)}</strong><small>{location.reason?.replaceAll('_', ' ') || 'Location update'} · {location.recordedBy?.username || 'System'}</small></div><time>{dateTime(location.recordedAt)}</time></div>)}</div><ListPagination page={locationPage} pages={locationPages} total={locationTotal} pageSize={locationPageSize} onPageChange={setLocationPage} onPageSizeChange={(value) => { setLocationPageSize(value); setLocationPage(1); }} /></> : <div className="detail-empty">No location changes have been recorded.</div>}
    </section>
  </div>;
}
