import React, { useCallback, useEffect, useState } from 'react';
import { Activity, ChevronLeft, ChevronRight, Search, UsersRound } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components';
import { OverviewFilters } from '../components/NetworkOverview';
import AdminAgentMoves from '../components/AdminAgentMoves';
import { useAuth } from '../AuthContext';

const activityStatuses = [
  { name: 'Active', range: '80+ transactions' },
  { name: 'Transacting', range: '30–79 transactions' },
  { name: 'Dormant', range: '1–29 transactions' },
  { name: 'Inactive', range: '0 transactions' },
];
const formatDate = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value)) : '—';

export default function MoolaPlusAgentList() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canAdminMove = user?.role?.toUpperCase() === 'ADMIN';
  const [searchParams] = useSearchParams();
  const [agents, setAgents] = useState([]);
  const [summary, setSummary] = useState(null);
  const [filterOptions, setFilterOptions] = useState(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(searchParams.get('status') || '');
  const [territoryFilters, setTerritoryFilters] = useState({ province: searchParams.get('province') || '', district: searchParams.get('district') || '', sector: searchParams.get('sector') || '', cell: searchParams.get('cell') || '', village: searchParams.get('village') || '', fromDate: searchParams.get('fromDate') || '', toDate: searchParams.get('toDate') || '' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  const loadAgents = useCallback(async (signal) => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: pageSize };
      if (search.trim()) params.search = search.trim();
      if (status) params.status = status;
      Object.assign(params, territoryFilters);
      const { data } = await api.get('/api/v1/reports/moola-plus/agents', { params, signal });
      if (signal?.aborted) return;
      setAgents(data.data || []);
      setSummary(data.summary || null);
      setFilterOptions(data.filters || null);
      setTotal(data.total || 0);
      setPages(data.pages || 0);
      setPage(data.page || 1);
      setStale(Boolean(data.stale));
      setFetchedAt(data.fetchedAt || null);
    } catch (err) {
      if (!signal?.aborted) setError(err.response?.data?.error || 'Could not load Moola Plus agents.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [page, pageSize, search, status, territoryFilters]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadAgents(controller.signal), search.trim() ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [loadAgents, retryKey, search]);

  const selectStatus = (nextStatus) => {
    setStatus((current) => current === nextStatus ? '' : nextStatus);
    setPage(1);
  };
  const totalAgents = Number(summary?.totalAgents || 0);
  const firstResult = total ? (page - 1) * pageSize + 1 : 0;
  const lastResult = Math.min(page * pageSize, total);

  return <div className="page moola-agent-list-page">
    <PageHeader title="Moola Plus agents" subtitle="Agent profiles and reported deposit activity from the DDIN registry." />
    <OverviewFilters network="Moola Plus" options={filterOptions} value={territoryFilters} onChange={(next) => { setTerritoryFilters(next); setPage(1); }} />
    <section className="moola-list-status-grid" aria-label="Moola Plus agent status filters">
      <button type="button" className={`moola-list-total${!status ? ' selected' : ''}`} onClick={() => { setStatus(''); setPage(1); }}><span><UsersRound size={17} />All agents</span><strong>{totalAgents.toLocaleString()}</strong><small>In your authorized coverage</small></button>
      {activityStatuses.map(({ name, range }) => <button type="button" key={name} className={`moola-list-status status-${name.toLowerCase()}${status === name ? ' selected' : ''}`} aria-pressed={status === name} onClick={() => selectStatus(name)}><span>{name}</span><strong>{Number(summary?.byStatus?.[name] || 0).toLocaleString()}</strong><small>{range}</small></button>)}
    </section>
    {fetchedAt && <p className="moola-sync-note">{stale ? 'Showing cached registry data' : 'DDIN registry'} · Last synchronized {formatDate(fetchedAt)}.</p>}

    <section className="agent-filter-bar surface-card" aria-label="Filter Moola Plus agents">
      <label className="visit-search agent-search-field"><Search size={16} aria-hidden="true" /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search name, login or business" aria-label="Search Moola Plus agents" /></label>
      <select className="input agent-status-select" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} aria-label="Filter by activity status"><option value="">All activity statuses</option>{activityStatuses.map(({ name }) => <option key={name} value={name}>{name}</option>)}</select>
      <label className="agent-page-size-control"><span>Rows</span><select className="input" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} aria-label="Rows per page"><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option></select></label>
      <span className="agent-result-count">{total.toLocaleString()} agents</span>
    </section>

    {error && <ErrorState message={error} onRetry={() => setRetryKey((value) => value + 1)} />}
    {loading ? <LoadingState message="Loading Moola Plus agents…" /> : !error && <section className="surface-card agent-table-card moola-agent-table-card">
      {agents.length ? <>
        <div className="table-scroll"><table className="data-table agent-table moola-agent-table"><thead><tr><th>Agent</th><th>Activity status</th><th>Reported transactions</th><th>Province · District</th><th>Sector · Cell · Village</th><th>Business category</th><th>Registered</th>{agents.some((agent) => agent.totalDeposited != null) && <th>Total deposited</th>}{canAdminMove && <th>Admin actions</th>}</tr></thead><tbody>{agents.map((agent) => <tr key={agent.id} onClick={() => navigate(`/moola-plus/agents/${encodeURIComponent(agent.id)}`)} tabIndex="0" onKeyDown={(event) => event.target === event.currentTarget && event.key === 'Enter' && navigate(`/moola-plus/agents/${encodeURIComponent(agent.id)}`)}>
          <td><div className="table-person"><span className="table-avatar">{(agent.name || 'A').slice(0, 1).toUpperCase()}</span><span><strong>{agent.name}</strong><small>{agent.loginName}</small>{agent.phone && <a className="agent-phone-link" href={`tel:${agent.phone.replace(/[^\d+]/g, '')}`} onClick={(event) => event.stopPropagation()}>{agent.phone}</a>}</span></div></td>
          <td><span className={`moola-status-pill status-${agent.activityStatus.toLowerCase()}`}><i />{agent.activityStatus}</span></td>
          <td><strong>{Number(agent.reportedDepositCount || 0).toLocaleString()}</strong></td>
          <td>{[agent.province, agent.district].filter(Boolean).join(' · ') || '—'}</td>
          <td>{[agent.sector, agent.cell, agent.village].filter(Boolean).join(' · ') || '—'}</td>
          <td>{agent.agentCategory || agent.businessType || '—'}</td>
          <td>{formatDate(agent.registrationDate)}</td>
          {agents.some((item) => item.totalDeposited != null) && <td>{agent.totalDeposited == null ? '—' : `${Number(agent.totalDeposited).toLocaleString()} RWF`}</td>}
          {canAdminMove && <td><AdminAgentMoves network="MOOLA_PLUS" agent={agent} onComplete={() => setRetryKey((value) => value + 1)} /></td>}
        </tr>)}</tbody></table></div>
        <div className="agent-pagination"><span className="agent-pagination-range">Showing {firstResult.toLocaleString()}–{lastResult.toLocaleString()} of {total.toLocaleString()}</span><div className="agent-pagination-controls" aria-label="Agent list pages"><span>Page {page} of {Math.max(pages, 1).toLocaleString()}</span><button className="agent-page-button" type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1} aria-label="Previous page"><ChevronLeft size={17} /></button><button className="agent-page-button" type="button" onClick={() => setPage((current) => Math.min(pages, current + 1))} disabled={pages === 0 || page >= pages} aria-label="Next page"><ChevronRight size={17} /></button></div></div>
      </> : <EmptyState icon={Activity} title="No Moola Plus agents found" message={search || status || Object.values(territoryFilters).some(Boolean) ? 'Try changing your filters.' : 'No agents are available in your authorized coverage.'} />}
      <div className="card-footnote"><Activity size={14} /><span>Status bands use the DDIN dashboard thresholds on the reported manual deposit count; the upstream API does not expose monthly transaction totals.</span></div>
    </section>}
  </div>;
}
