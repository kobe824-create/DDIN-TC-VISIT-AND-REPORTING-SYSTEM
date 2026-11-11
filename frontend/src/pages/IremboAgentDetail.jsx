import React, { useCallback, useEffect, useState } from 'react';
import { Activity, ArrowLeft, MapPin, Phone, Play, UserRound } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../AuthContext';
import PageHeader from '../components/PageHeader';
import AgentActions from '../components/AgentActions';
import AdminAgentMoves from '../components/AdminAgentMoves';
import { ErrorState, LoadingState } from '../components';

const formatDate = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value)) : '—';
const formatDateTime = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Kigali' }).format(new Date(value)) : '—';
const statusClass = (value) => String(value || 'inactive').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export default function IremboAgentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [agent, setAgent] = useState(null);
  const [localAgent, setLocalAgent] = useState(null);
  const [sync, setSync] = useState(null);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get(`/api/v1/reports/irembo/agents/${encodeURIComponent(id)}`);
      setAgent(data.data); setSync(data);
    } catch (err) { setError(err.response?.data?.error || 'Could not load this Irembo agent.'); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (user?.role?.toUpperCase() !== 'TC' || !agent?.localAgentId) { setLocalAgent(null); return undefined; }
    let active = true;
    api.get(`/api/v1/agents/${encodeURIComponent(agent.localAgentId)}`).then(({ data }) => { if (active) setLocalAgent(data); }).catch(() => { if (active) setLocalAgent(null); });
    return () => { active = false; };
  }, [agent?.localAgentId, user?.role]);
  const canVisit = user?.role?.toUpperCase() === 'TC';
  const startVisit = async () => {
    if (!agent) return;
    setLinking(true);
    try {
      const fieldAgentId = agent.localAgentId || (await api.post(`/api/v1/agents/irembo/${encodeURIComponent(agent.agentId || agent.id)}/field-record`)).data.id;
      navigate(`/visits/new?agentId=${encodeURIComponent(fieldAgentId)}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not prepare this Irembo agent for a visit.');
    } finally { setLinking(false); }
  };

  return <div className="page agent-detail-page network-agent-detail-page">
    <PageHeader title={agent?.name || 'Irembo agent'} subtitle={agent?.agentId || 'Agent profile from the Irembo feed.'} breadcrumbs={[{ label: 'Agents', href: '/agents' }, { label: agent?.name || 'Irembo agent' }]} actions={<div className="flex gap-2"><button className="btn btn-secondary" onClick={() => navigate('/agents')}><ArrowLeft size={16} />Back to agents</button>{canVisit && <button className="btn btn-primary" onClick={startVisit} disabled={linking || !agent?.agentId}><Play size={15} />{linking ? 'Preparing visit…' : 'Start visit'}</button>}{['ADMIN', 'TC'].includes(user?.role?.toUpperCase()) && agent?.localAgentId && <button className="btn btn-secondary" onClick={() => navigate(`/agents/${encodeURIComponent(agent.localAgentId)}`)}>Field record</button>}</div>} />
    {error && <ErrorState message={error} onRetry={load} />}
    {loading ? <LoadingState message="Loading agent profile…" /> : !error && agent && <>
      <section className="agent-profile-grid network-agent-profile-grid">
        <article className="surface-card agent-profile-card"><div className="agent-identity"><span className="agent-profile-avatar">{(agent.name || 'A').slice(0, 1).toUpperCase()}</span><div><span className="section-kicker">AGENT PROFILE</span><h2>{agent.name}</h2><p>{agent.agentId || 'Agent ID unavailable'}</p></div><span className={`moola-status-pill status-${statusClass(agent.activityStatus)}`}>{agent.activityStatus}</span></div>
          <div className="agent-contact-grid"><div><span><Phone size={14} />Phone</span><strong>{agent.phoneNumber ? <a className="agent-phone-link" href={`tel:${agent.phoneNumber.replace(/[^\d+]/g, '')}`}>{agent.phoneNumber}</a> : 'Not provided'}</strong></div><div><span><UserRound size={14} />Franchisee</span><strong>{agent.franchisee || 'Not recorded'}</strong></div><div><span><Activity size={14} />Transaction count</span><strong>{Number(agent.transactionCount || 0).toLocaleString()}</strong></div><div><span>Registered</span><strong>{formatDate(agent.registrationDate)}</strong></div></div>
        </article>
        <article className="surface-card agent-location-card"><div className="detail-panel-heading"><span className="detail-icon gps-icon"><MapPin size={17} /></span><div><h3>Registered territory</h3><p>{[agent.province, agent.district, agent.sector, agent.cell, agent.village].filter(Boolean).join(' · ') || 'Location unavailable in feed'}</p></div></div><div className="agent-coordinate">{agent.businessName || 'Business details not provided'}</div><div className="agent-location-footer"><span>{agent.district || 'District unavailable'}</span><span>{agent.sector || 'Sector unavailable'}</span></div></article>
      </section>
      {user?.role?.toUpperCase() === 'ADMIN' && <section className="surface-card admin-agent-profile-actions"><div className="detail-panel-heading"><div><h3>Admin actions</h3><p>Update the agent’s registered territory or route them to another TC.</p></div></div><AdminAgentMoves network="IREMBO" agent={agent} onComplete={load} /></section>}
      <section className="surface-card agent-history-card network-transaction-panel"><div className="agent-tabs"><span className="active">Transaction activity</span></div>
        <div className="network-transaction-summary"><div><small>Transactions reported</small><strong>{Number(agent.transactionCount || 0).toLocaleString()}</strong></div><div><small>Activity status</small><strong>{agent.activityStatus}</strong></div><div><small>Feed date</small><strong>{formatDate(agent.activityDate || agent.registrationDate)}</strong></div></div>
        <p className="moola-data-note"><Activity size={14} />The Irembo feed supplies an aggregate transaction count. Individual transaction dates and IDs are not included in the current response.</p>
        <div className="card-footnote">{sync?.stale ? 'Showing the last successful feed refresh.' : 'Irembo feed'} · Last synchronized {formatDateTime(sync?.fetchedAt)} Rwanda time.</div>
      </section>
      {canVisit && localAgent && <AgentActions agent={localAgent} assignedTerritories={user?.assignedTerritories || []} onAgentChange={setLocalAgent} />}
    </>}
  </div>;
}
