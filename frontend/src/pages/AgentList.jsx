import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ChevronLeft, ChevronRight, MapPin, Plus, Search, UsersRound } from 'lucide-react';
import { useAuth } from '../AuthContext';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { EmptyState, ErrorState, LoadingState, StatusBadge } from '../components';

export default function AgentList() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [agents, setAgents] = useState([]);
  const [summary, setSummary] = useState({ active: 0, locationVerified: 0 });
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [retryKey, setRetryKey] = useState(0);
  const role = user?.role?.toUpperCase();
  const canCreate = ['ADMIN', 'MANAGER', 'TC'].includes(role);

  const loadAgents = useCallback(async (signal) => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: pageSize };
      if (search.trim()) params.search = search.trim();
      if (status) params.status = status;
      const { data } = await api.get('/api/v1/agents', { params, signal });
      if (signal?.aborted) return;
      setAgents(data.data || []);
      setTotal(data.total ?? data.data?.length ?? 0);
      setPages(data.pages ?? 0);
      setPage(data.page ?? page);
      setSummary(data.summary || { active: 0, locationVerified: 0 });
    } catch (err) {
      if (!signal?.aborted) setError(err.response?.data?.error || 'Could not load agents.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [page, pageSize, search, status]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => loadAgents(controller.signal), search.trim() ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadAgents, retryKey, search]);

  useEffect(() => {
    const lastPage = Math.max(pages, 1);
    if (page > lastPage) setPage(lastPage);
  }, [page, pages]);

  const firstResult = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastResult = Math.min(page * pageSize, total);

  return <div className="agent-list-page page">
    <PageHeader
      title="Agents"
      subtitle="Search agents and review registered locations and status."
      breadcrumbs={[{ label: 'Workspace', href: '/dashboard' }, { label: 'Agents' }]}
      actions={canCreate && <button className="btn btn-primary" onClick={() => navigate('/agents/new')}><Plus size={16} />Register agent</button>}
    />

    <section className="agent-overview-strip">
      <div><span className="agent-overview-icon"><UsersRound size={17} /></span><span><small>Matching agents</small><strong>{total.toLocaleString()}</strong></span></div>
      <div><span className="agent-overview-icon green"><CheckCircle2 size={17} /></span><span><small>Active agents</small><strong>{summary.active.toLocaleString()}</strong></span></div>
      <div><span className="agent-overview-icon orange"><MapPin size={17} /></span><span><small>Location verified</small><strong>{summary.locationVerified.toLocaleString()}</strong></span></div>
    </section>

    <section className="agent-filter-bar surface-card" aria-label="Filter agents">
      <label className="visit-search agent-search-field">
        <Search size={16} aria-hidden="true" />
        <input
          value={search}
          onChange={(event) => { setSearch(event.target.value); setPage(1); }}
          placeholder="Search name, phone, agent ID or business"
          aria-label="Search agents"
        />
      </label>
      <select className="input agent-status-select" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} aria-label="Filter by status">
        <option value="">All statuses</option>
        <option value="ACTIVE">Active</option>
        <option value="INACTIVE">Inactive</option>
        <option value="SUSPENDED">Suspended</option>
        <option value="PENDING">Pending</option>
      </select>
      <label className="agent-page-size-control">
        <span>Rows</span>
        <select className="input" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} aria-label="Rows per page">
          <option value={10}>10</option>
          <option value={25}>25</option>
          <option value={50}>50</option>
        </select>
      </label>
      <span className="agent-result-count">{total.toLocaleString()} agents</span>
    </section>

    {error && <ErrorState message={error} onRetry={() => setRetryKey((key) => key + 1)} />}
    {loading ? <LoadingState message="Loading agents…" /> : !error && <section className="surface-card agent-table-card">
      {agents.length ? <>
        <div className="table-scroll"><table className="data-table agent-table"><thead><tr><th>Agent</th><th>Business</th><th>Territory</th><th>Champion</th><th>Status</th><th>Registered GPS</th></tr></thead><tbody>{agents.map((agent) => <tr key={agent.id} onClick={() => navigate(`/agents/${agent.id}`)} tabIndex="0" onKeyDown={(event) => event.target === event.currentTarget && event.key === 'Enter' && navigate(`/agents/${agent.id}`)}>
          <td><div className="table-person"><span className="table-avatar">{(agent.name || 'A').slice(0, 1).toUpperCase()}</span><span><strong>{agent.name}</strong><small>{agent.agentId}</small>{agent.phoneNumber && <a className="agent-phone-link" href={`tel:${agent.phoneNumber.replace(/[^\d+]/g, '')}`} aria-label={`Call ${agent.name}`} onClick={(event) => event.stopPropagation()}>{agent.phoneNumber}</a>}</span></div></td>
          <td>{agent.businessName || <span className="muted-dash">—</span>}</td>
          <td>{agent.territory?.name || '—'}{agent.sector?.name ? <small className="visit-subtext">{agent.sector.name}</small> : null}</td>
          <td>{agent.champion ? `${agent.champion.firstName || ''} ${agent.champion.lastName || ''}`.trim() : <span className="muted-dash">Unassigned</span>}</td>
          <td><StatusBadge status={agent.status} /></td>
          <td><span className={`location-result ${agent.locationVerified ? 'verified' : 'needs-review'}`}><span />{agent.locationVerified ? 'Verified' : 'Unverified'}</span></td>
        </tr>)}</tbody></table></div>
        <div className="agent-pagination">
          <span className="agent-pagination-range">Showing {firstResult.toLocaleString()}–{lastResult.toLocaleString()} of {total.toLocaleString()}</span>
          <div className="agent-pagination-controls" aria-label="Agent list pages">
            <span>Page {page} of {Math.max(pages, 1).toLocaleString()}</span>
            <button className="agent-page-button" type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1} aria-label="Previous page"><ChevronLeft size={17} /></button>
            <button className="agent-page-button" type="button" onClick={() => setPage((current) => Math.min(pages, current + 1))} disabled={pages === 0 || page >= pages} aria-label="Next page"><ChevronRight size={17} /></button>
          </div>
        </div>
      </> : <EmptyState icon={UsersRound} title="No agents found" message={search || status ? 'Try changing your filters.' : 'Agents registered in your assigned areas will appear here.'} actionLabel={canCreate ? 'Register an agent' : undefined} action={canCreate ? () => navigate('/agents/new') : undefined} />}
      <div className="card-footnote"><MapPin size={14} /><span>Agent GPS is stored as the registered visit location and updated with a location history record.</span></div>
    </section>}
  </div>;
}
