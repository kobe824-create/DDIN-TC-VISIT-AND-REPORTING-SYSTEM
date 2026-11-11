import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components';
import { OverviewFilters } from '../components/NetworkOverview';
import AdminAgentMoves from '../components/AdminAgentMoves';
import { useAuth } from '../AuthContext';
import MoolaPlusAgentList from './MoolaPlusAgentList';
import { MOOLA_PLUS_NETWORK, useNetwork } from '../NetworkContext';

const formatDate = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value)) : '—';
const statusClass = (value) => String(value || 'inactive').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function IremboAgentList() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canAdminMove = user?.role?.toUpperCase() === 'ADMIN';
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState({
    province: searchParams.get('province') || '', district: searchParams.get('district') || '', sector: searchParams.get('sector') || '',
    cell: searchParams.get('cell') || '', village: searchParams.get('village') || '', fromDate: searchParams.get('fromDate') || '', toDate: searchParams.get('toDate') || '',
  });
  const [status, setStatus] = useState(searchParams.get('status') || '');
  const [search, setSearch] = useState('');
  const [agents, setAgents] = useState([]);
  const [options, setOptions] = useState(null);
  const [activityLevels, setActivityLevels] = useState([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  const load = useCallback(async (signal) => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/api/v1/reports/irembo/agents', { params: { ...filters, status, search: search.trim() || undefined, page, limit: 25 }, signal });
      if (signal?.aborted) return;
      const levels = Array.isArray(data.activityLevels) ? data.activityLevels : [];
      setAgents(data.data || []); setOptions(data.filters || null); setActivityLevels(levels); setTotal(data.total || 0); setPages(data.pages || 0); setPage(data.page || 1);
      setStatus((current) => current && !levels.some((level) => level.name === current) ? '' : current);
    } catch (err) { if (!signal?.aborted) setError(err.response?.data?.error || 'Could not load Irembo agents.'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [filters, status, search, page]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), search.trim() ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load, retryKey, search]);

  const first = total ? (page - 1) * 25 + 1 : 0;
  return <div className="page agent-list-page network-agent-list-page">
    <PageHeader title="Irembo agents" subtitle="Agents and transaction status from the Irembo activity feed." breadcrumbs={[{ label: 'Workspace', href: '/dashboard' }, { label: 'Agents' }]} />
    <OverviewFilters network="Irembo" options={options} value={filters} onChange={(next) => { setFilters(next); setPage(1); }} />
    <section className="agent-filter-bar surface-card" aria-label="Search Irembo agents">
      <label className="visit-search agent-search-field"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search name, agent code, phone or location" aria-label="Search Irembo agents" /></label>
      <select className="input agent-status-select" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} aria-label="Filter by activity status"><option value="">All activity statuses</option>{activityLevels.map(({ name }) => <option value={name} key={name}>{name}</option>)}</select>
      <span className="agent-result-count">{total.toLocaleString()} agents</span>
    </section>
    {error && <ErrorState message={error} onRetry={() => setRetryKey((value) => value + 1)} />}
    {loading ? <LoadingState message="Loading Irembo agents…" /> : <section className="surface-card agent-table-card">
      {agents.length ? <>
        <div className="table-scroll"><table className="data-table agent-table"><thead><tr><th>Agent</th><th>Phone</th><th>Activity status</th><th>Transactions</th><th>Province · District</th><th>Sector · Cell · Village</th><th>Registered</th>{canAdminMove && <th>Admin actions</th>}</tr></thead><tbody>{agents.map((agent) => <tr key={agent.id} onClick={() => navigate(`/irembo/agents/${encodeURIComponent(agent.id)}`)} tabIndex="0" onKeyDown={(event) => event.target === event.currentTarget && event.key === 'Enter' && navigate(`/irembo/agents/${encodeURIComponent(agent.id)}`)}>
          <td><div className="table-person"><span className="table-avatar">{(agent.name || 'A').slice(0, 1).toUpperCase()}</span><span><strong>{agent.name}</strong><small>{agent.agentId || 'Agent code unavailable'}</small></span></div></td>
          <td>{agent.phoneNumber ? <a className="agent-phone-link" href={`tel:${agent.phoneNumber.replace(/[^\d+]/g, '')}`} onClick={(event) => event.stopPropagation()}>{agent.phoneNumber}</a> : '—'}</td><td><span className={`moola-status-pill status-${statusClass(agent.activityStatus)}`}>{agent.activityStatus}</span></td><td><strong>{Number(agent.transactionCount || 0).toLocaleString()}</strong></td><td>{[agent.province, agent.district].filter(Boolean).join(' · ') || '—'}</td><td>{[agent.sector, agent.cell, agent.village].filter(Boolean).join(' · ') || '—'}</td><td>{formatDate(agent.registrationDate)}</td>{canAdminMove && <td><AdminAgentMoves network="IREMBO" agent={agent} onComplete={() => setRetryKey((value) => value + 1)} /></td>}
        </tr>)}</tbody></table></div>
        <div className="agent-pagination"><span className="agent-pagination-range">Showing {first.toLocaleString()}–{Math.min(page * 25, total).toLocaleString()} of {total.toLocaleString()}</span><div className="agent-pagination-controls"><span>Page {page} of {Math.max(pages, 1)}</span><button className="agent-page-button" type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label="Previous page"><ChevronLeft size={17} /></button><button className="agent-page-button" type="button" disabled={!pages || page >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))} aria-label="Next page"><ChevronRight size={17} /></button></div></div>
      </> : <EmptyState title="No Irembo agents found" message={search || status || Object.values(filters).some(Boolean) ? 'Try changing your filters.' : 'The Irembo feed returned no agents.'} />}
      <div className="card-footnote">Activity status is calculated from the transaction total: Active 80+, Transacting 30–79, Dormant 1–29, and Inactive 0.</div>
    </section>}
  </div>;
}

export default function AgentList() {
  const { network } = useNetwork();
  return network === MOOLA_PLUS_NETWORK ? <MoolaPlusAgentList /> : <IremboAgentList />;
}
