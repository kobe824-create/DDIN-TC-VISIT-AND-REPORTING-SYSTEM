import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeftRight, ChevronLeft, ChevronRight, Clock3, MapPin, RefreshCw, Search, UsersRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { ErrorState, LoadingState } from '../components';
import PageHeader from '../components/PageHeader';
import { MOOLA_PLUS_NETWORK, useNetwork } from '../NetworkContext';

const tabs = [
  { id: 'ALL', label: 'All agents' },
  { id: 'MOVED_BY_ME', label: 'Moved by me' },
  { id: 'PENDING', label: 'Pending' },
  { id: 'NOT_MOVED', label: 'Not moved yet' },
];

const dateLabel = (value) => value
  ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value))
  : '—';
const timeLabel = (value) => value
  ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Kigali' }).format(new Date(value))
  : '';

export default function AgentMoveTracker() {
  const navigate = useNavigate();
  const { network } = useNetwork();
  const networkName = network === MOOLA_PLUS_NETWORK ? 'Moola Plus' : 'Irembo';
  const [status, setStatus] = useState('ALL');
  const [kind, setKind] = useState('ALL');
  const [district, setDistrict] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [districts, setDistricts] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(null);
  const latestRequestRef = useRef(0);
  const requestActiveRef = useRef(false);

  const load = useCallback(async (signal, { silent = false } = {}) => {
    if (silent && requestActiveRef.current) return;
    const requestId = ++latestRequestRef.current;
    requestActiveRef.current = true;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const { data } = await api.get('/api/v1/reports/agent-movement-tracker', {
        params: {
          _refresh: Date.now(),
          network,
          status,
          kind,
          district: district || undefined,
          search: search.trim() || undefined,
          page,
        },
        signal,
      });
      if (signal?.aborted || requestId !== latestRequestRef.current) return;
      setRows(data.data || []);
      setSummary(data.summary || {});
      setDistricts(data.filters?.districts || []);
      setTotal(data.total || 0);
      setPages(data.pages || 0);
      setPage(data.page || 1);
      setUpdatedAt(Date.now());
      setError('');
    } catch (err) {
      if (!signal?.aborted && requestId === latestRequestRef.current && !silent) setError(err.response?.data?.error || 'Could not load your agent movement tracker.');
    } finally {
      if (requestId === latestRequestRef.current) {
        requestActiveRef.current = false;
        if (!signal?.aborted) setLoading(false);
      }
    }
  }, [network, status, kind, district, search, page]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), search.trim() ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load, retryKey, search]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') void load(undefined, { silent: true });
    };
    const interval = window.setInterval(refreshIfVisible, 10000);
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [load]);

  const changeFilter = (setter, value) => {
    setter(value);
    setPage(1);
  };
  const statusCounts = {
    ALL: Number(summary.totalAgents || 0),
    MOVED_BY_ME: Number(summary.movedByMe || 0),
    PENDING: Number(summary.pending || 0),
    NOT_MOVED: Number(summary.notMoved || 0),
  };

  return <div className="page agent-move-tracker-page">
    <PageHeader
      title="Agent moves"
      subtitle={`Track transfers and territory relocations for your ${networkName} agents.`}
      breadcrumbs={[{ label: 'Workspace', href: '/dashboard' }, { label: 'Agents' }, { label: 'Agent moves' }]}
    />

    <section className="move-tracker-metrics" aria-label="Your agent movement totals">
      <article className="surface-card move-tracker-metric"><span className="move-tracker-metric-icon"><UsersRound size={18} /></span><div><small>Agents in your tracker</small><strong>{Number(summary.totalAgents || 0).toLocaleString()}</strong><span>Assigned roster and your moved agents</span></div></article>
      <article className="surface-card move-tracker-metric"><span className="move-tracker-metric-icon moved"><ArrowLeftRight size={18} /></span><div><small>Moved by you</small><strong>{Number(summary.movedByMe || 0).toLocaleString()}</strong><span>{Number(summary.moved || 0).toLocaleString()} agents have a completed move</span></div></article>
      <article className="surface-card move-tracker-metric"><span className="move-tracker-metric-icon transfer"><ArrowLeftRight size={18} /></span><div><small>Transfers completed</small><strong>{Number(summary.transfersByMe || 0).toLocaleString()}</strong><span>Agents transferred by you</span></div></article>
      <article className="surface-card move-tracker-metric"><span className="move-tracker-metric-icon relocation"><MapPin size={18} /></span><div><small>Relocations approved</small><strong>{Number(summary.relocationsByMe || 0).toLocaleString()}</strong><span>Agents relocated by you</span></div></article>
    </section>

    <section className="surface-card move-tracker-card">
      <div className="move-tracker-heading">
        <div><h2>Movement history</h2><p>Use the status, movement type, territory, or search to find an agent.</p></div>
        <div className="move-tracker-live-actions">
          <span className="move-tracker-live-status" title="Automatically refreshes every 10 seconds while this page is visible." aria-live="polite">{updatedAt ? `Live · updated ${timeLabel(updatedAt)}` : 'Updating…'}</span>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void load(undefined, { silent: true })} disabled={loading}><RefreshCw size={14} />Refresh</button>
          <span className="move-tracker-pending"><Clock3 size={15} />{Number(summary.pending || 0).toLocaleString()} pending</span>
        </div>
      </div>

      <div className="move-tracker-tabs" role="tablist" aria-label="Filter agents by movement status">
        {tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={status === tab.id} className={status === tab.id ? 'active' : ''} onClick={() => changeFilter(setStatus, tab.id)}>
          <span>{tab.label}</span><strong>{statusCounts[tab.id].toLocaleString()}</strong>
        </button>)}
      </div>

      <div className="move-tracker-filters">
        <label className="visit-search move-tracker-search"><Search size={16} aria-hidden="true" /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search name, code, phone or location" aria-label="Search agents" /></label>
        <select className="input" value={kind} onChange={(event) => changeFilter(setKind, event.target.value)} aria-label="Filter by movement type">
          <option value="ALL">All movement types</option><option value="TRANSFER">Transfers</option><option value="RELOCATION">Relocations</option>
        </select>
        <select className="input" value={district} onChange={(event) => changeFilter(setDistrict, event.target.value)} aria-label="Filter by district">
          <option value="">All territories</option>{districts.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <span className="move-tracker-result-count">{total.toLocaleString()} agents</span>
      </div>

      {error && <ErrorState message={error} onRetry={() => setRetryKey((current) => current + 1)} />}
      {loading ? <LoadingState message="Loading agent movement history…" /> : !error && <>
        {rows.length ? <>
          <div className="table-scroll"><table className="data-table move-tracker-table">
            <thead><tr><th>Agent</th><th>Territory</th><th>Movement</th><th>Activity</th><th>Date</th><th aria-label="Open profile" /></tr></thead>
            <tbody>{rows.map((agent) => <tr key={agent.id} className="move-tracker-row" onClick={() => navigate(agent.profilePath)} tabIndex={0} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === 'Enter') navigate(agent.profilePath); }}>
              <td><div className="table-person"><span className="table-avatar">{(agent.name || 'A').slice(0, 1).toUpperCase()}</span><span><strong>{agent.name}</strong><small>{agent.code || 'Agent code unavailable'}{agent.phone ? ` · ${agent.phone}` : ''}</small></span></div></td>
              <td><span className="move-tracker-location"><MapPin size={14} />{agent.district || 'Territory unavailable'}</span>{agent.location && <small className="move-tracker-subtext">{agent.location}</small>}</td>
              <td>{agent.movementType ? <span className={`move-kind-pill ${agent.movementType.toLowerCase()}`}>{agent.movementType === 'TRANSFER' ? 'Transfer' : 'Relocation'}</span> : '—'}</td>
              <td><span className={`move-state-pill ${agent.status.toLowerCase().replaceAll('_', '-')}`}>{agent.status === 'NOT_MOVED' ? 'Not moved yet' : agent.status === 'PENDING' ? 'Pending' : agent.movedByMe ? 'Moved by you' : 'Moved'}</span></td>
              <td>{dateLabel(agent.movedAt)}</td>
              <td><span className="move-tracker-open">Open</span></td>
            </tr>)}</tbody>
          </table></div>
          <div className="agent-pagination"><span className="agent-pagination-range">Showing {total ? ((page - 1) * 25 + 1).toLocaleString() : 0}–{Math.min(page * 25, total).toLocaleString()} of {total.toLocaleString()}</span><div className="agent-pagination-controls" aria-label="Agent movement pages"><span>Page {page} of {Math.max(pages, 1)}</span><button className="agent-page-button" type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} aria-label="Previous page"><ChevronLeft size={17} /></button><button className="agent-page-button" type="button" disabled={!pages || page >= pages} onClick={() => setPage((current) => Math.min(pages, current + 1))} aria-label="Next page"><ChevronRight size={17} /></button></div></div>
        </> : <div className="move-tracker-empty"><Activity size={22} /><strong>No agents match these filters</strong><span>Try a different status, movement type, territory, or search.</span></div>}
      </>}
    </section>
  </div>;
}
