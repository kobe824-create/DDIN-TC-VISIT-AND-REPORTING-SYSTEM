import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Search, ShieldCheck } from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, ListPagination, LoadingState } from '../components';

const actions = ['', 'LOGIN', 'CREATE_VISIT', 'COMPLETE_VISIT', 'CREATE_AGENT', 'UPDATE_AGENT', 'UPDATE_AGENT_LOCATION', 'CREATE_USER', 'UPDATE_USER', 'UPDATE_CONFIG', 'CREATE_TERRITORY', 'ASSIGN_TERRITORY'];
const dateTime = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) : '—';

export default function AuditLogs() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [range, setRange] = useState('30');
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: pageSize };
      if (search.trim()) params.search = search.trim();
      if (action) params.action = action;
      if (range !== 'all') {
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - Number(range));
        params.fromDate = fromDate.toISOString().slice(0, 10);
      }
      const { data } = await api.get('/api/v1/reports/audit-logs', { params });
      setLogs(data.data || []);
      setTotal(data.meta?.total ?? data.data?.length ?? 0);
      setPages(data.meta?.pages ?? 0);
      setPage(data.meta?.page ?? page);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load audit records.');
    } finally {
      setLoading(false);
    }
  }, [action, range, page, pageSize, search]);

  useEffect(() => {
    const timer = window.setTimeout(load, search.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);
  useEffect(() => {
    const lastPage = Math.max(pages, 1);
    if (page > lastPage) setPage(lastPage);
  }, [page, pages]);

  const tone = (value) => value.includes('CREATE') || value.includes('COMPLETE') ? 'audit-green' : value.includes('UPDATE') || value.includes('CHANGE') ? 'audit-amber' : value.includes('DELETE') ? 'audit-red' : 'audit-blue';

  return <div className="audit-page page"><PageHeader title="Audit trail" subtitle="A timestamped record of access and important system changes." />
    <section className="agent-filter-bar surface-card"><label className="visit-search"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search account, action or resource" /></label><select className="input agent-status-select" value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }}><option value="">All actions</option>{actions.filter(Boolean).map((item) => <option key={item} value={item}>{item.replaceAll('_', ' ')}</option>)}</select><select className="input agent-status-select" value={range} onChange={(event) => { setRange(event.target.value); setPage(1); }}><option value="30">Last 30 days</option><option value="7">Last 7 days</option><option value="1">Today</option><option value="all">All time</option></select><span className="agent-result-count">{total.toLocaleString()} events</span></section>
    {error && <ErrorState message={error} onRetry={() => load()} />}
    {loading ? <LoadingState message="Loading audit trail…" /> : !error && <section className="surface-card audit-table-card">{logs.length ? <div className="table-scroll"><table className="data-table audit-table"><thead><tr><th>Timestamp</th><th>Account</th><th>Action</th><th>Resource</th><th>Reference</th><th>Source</th></tr></thead><tbody>{logs.map((item) => <React.Fragment key={item.id}><tr className="audit-row" onClick={() => setExpanded(expanded === item.id ? null : item.id)}><td>{dateTime(item.createdAt)}</td><td><strong>{item.user?.username || 'System'}</strong></td><td><span className={`audit-action ${tone(item.action)}`}>{item.action.replaceAll('_', ' ')}</span></td><td>{item.resourceType}</td><td><code>{item.resourceId || '—'}</code></td><td>{item.ipAddress || '—'}</td></tr>{expanded === item.id && <tr><td colSpan="6"><div className="audit-details"><strong>Event details</strong><pre>{JSON.stringify(item.details || {}, null, 2)}</pre><small>{item.userAgent || 'No browser details recorded'}</small></div></td></tr>}</React.Fragment>)}</tbody></table></div> : <div className="table-empty"><div className="empty-mark"><Activity size={20} /></div><strong>No audit events found</strong><span>Try a wider date range or another action.</span></div>}
      <ListPagination page={page} pages={pages} total={total} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} />
      <div className="card-footnote"><ShieldCheck size={14} /><span>Audit events are retained by the Reports service.</span></div>
    </section>}
  </div>;
}
