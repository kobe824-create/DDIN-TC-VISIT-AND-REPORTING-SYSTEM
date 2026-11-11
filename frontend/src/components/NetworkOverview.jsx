import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { ErrorState, LoadingState } from './index';

const dimensions = [
  ['province', 'Province'], ['district', 'District'], ['sector', 'Sector'], ['cell', 'Cell'], ['village', 'Village'],
];
const number = (value) => Number(value || 0).toLocaleString();
const statusClass = (value) => String(value || 'inactive').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;

export function OverviewFilters({ network, options, value, onChange }) {
  const locations = options?.locations || [];
  const fields = useMemo(() => {
    const result = {};
    for (let index = 0; index < dimensions.length; index += 1) {
      const [key] = dimensions[index];
      const parents = dimensions.slice(0, index).map(([parentKey]) => parentKey);
      const matches = locations.filter((location) => parents.every((parentKey) => !value[parentKey] || String(location[parentKey] || '') === value[parentKey]));
      result[key] = [...new Set(matches.map((location) => String(location[key] || '')).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    }
    return result;
  }, [locations, value]);

  const choose = (key, nextValue) => {
    const next = { ...value, [key]: nextValue };
    const index = dimensions.findIndex(([dimension]) => dimension === key);
    dimensions.slice(index + 1).forEach(([child]) => { next[child] = ''; });
    onChange(next);
  };

  return <section className="overview-filters surface-card" aria-label={`${network} agent filters`}>
    <div className="overview-filter-clear-row"><button type="button" className="subtle-link" onClick={() => onChange({ province: '', district: '', sector: '', cell: '', village: '', fromDate: '', toDate: '' })}>Clear filters</button></div>
    <div className="overview-filter-grid">
      {dimensions.map(([key, label]) => <label key={key}>{label}<select className="input" value={value[key] || ''} onChange={(event) => choose(key, event.target.value)} disabled={!options || (key !== 'province' && dimensions.slice(0, dimensions.findIndex(([item]) => item === key)).some(([parent]) => !value[parent]))}>
        <option value="">All {label.toLocaleLowerCase()}s</option>{(fields[key] || []).map((name) => <option value={name} key={name}>{name}</option>)}
      </select></label>)}
      <label>From<input className="input" type="date" value={value.fromDate || ''} max={value.toDate || today} onChange={(event) => onChange({ ...value, fromDate: event.target.value })} /></label>
      <label>To<input className="input" type="date" value={value.toDate || ''} min={value.fromDate || undefined} max={today} onChange={(event) => onChange({ ...value, toDate: event.target.value })} /></label>
    </div>
  </section>;
}

export function PerformanceRanking({ performance, network, showTcCoverage = false, filters = {} }) {
  const navigate = useNavigate();
  const [fieldProgress, setFieldProgress] = useState(null);
  const [fieldProgressLoading, setFieldProgressLoading] = useState(false);
  const [fieldProgressError, setFieldProgressError] = useState('');
  const agentPath = network === 'Moola Plus' ? '/moola-plus/agents/' : '/irembo/agents/';
  useEffect(() => {
    if (!showTcCoverage || performance?.kind !== 'territories') {
      setFieldProgress(null);
      setFieldProgressError('');
      setFieldProgressLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setFieldProgress(null);
    setFieldProgressError('');
    setFieldProgressLoading(true);
    api.get('/api/v1/reports/field-progress', {
      params: { fromDate: filters.fromDate || undefined, toDate: filters.toDate || undefined },
      signal: controller.signal,
    }).then(({ data }) => {
      if (!controller.signal.aborted) setFieldProgress(data);
    }).catch((error) => {
      if (!controller.signal.aborted) setFieldProgressError(error.response?.data?.error || 'Could not load TC coverage details.');
    }).finally(() => {
      if (!controller.signal.aborted) setFieldProgressLoading(false);
    });
    return () => controller.abort();
  }, [showTcCoverage, performance?.kind, filters.fromDate, filters.toDate]);
  const tcProgressById = new Map((fieldProgress?.rankings || []).map((row) => [row.tcId, row]));
  if (!performance) return null;
  if (performance.kind === 'territories') return <section className="surface-card performance-ranking">
    <div className="surface-heading"><div><span className="section-kicker">TERRITORY PERFORMANCE</span><h3>TCs ranked by active agents</h3><p>{network} transaction activity · highest to lowest</p></div></div>
    {performance.territories?.length ? <ol>{performance.territories.map((item, index) => {
      const tcProgress = tcProgressById.get(item.id);
      return <li key={item.id}><span className="performance-rank">{index + 1}</span><span className="performance-copy"><strong>{item.name}</strong><small>{item.districts.join(' · ') || 'No district assigned'}</small></span>{showTcCoverage && <span className="performance-tc-metrics" aria-label={tcProgress ? `${tcProgress.coveragePercentage}% coverage, minimum ${tcProgress.minimumAgentsPerDay} agents per weekday` : 'TC coverage details'}><span><strong>{tcProgress ? `${Number(tcProgress.coveragePercentage || 0).toFixed(1)}%` : fieldProgressLoading ? '…' : '—'}</strong><small>coverage</small></span><span><strong>{tcProgress ? number(tcProgress.minimumAgentsPerDay) : fieldProgressLoading ? '…' : '—'}</strong><small>min / weekday</small></span></span>}<span className="performance-count"><strong>{number(item.activeAgents)}</strong><small>active</small></span></li>;
    })}</ol> : <div className="detail-empty">No active TC district assignments are available.</div>}
    {showTcCoverage && fieldProgressError && <p className="card-footnote" role="status">{fieldProgressError}</p>}
    <div className="performance-agent-columns admin-agent-rankings">
      {[['Best transacting agents', performance.best || []], ['Needs attention', performance.needsAttention || []]].map(([title, agents]) => <div key={title}><h4>{title}</h4>{agents.length ? <ol>{agents.map((agent) => <li key={agent.id}><span className="performance-copy"><button className="performance-agent-open" type="button" onClick={() => navigate(`${agentPath}${encodeURIComponent(agent.id)}`)}>{agent.name}</button><small>{[agent.district, agent.sector, agent.cell, agent.village].filter(Boolean).join(' · ') || 'Location not available'}</small></span><span className="performance-count"><strong>{number(agent.transactionCount ?? agent.reportedDepositCount)}</strong><small>transactions</small></span></li>)}</ol> : <p className="detail-empty">No agents are available in this selection.</p>}</div>)}
    </div>
  </section>;
  return <section className="surface-card performance-ranking">
    <div className="surface-heading"><div><span className="section-kicker">AGENT PERFORMANCE</span><h3>Your strongest and lowest activity</h3><p>Ranked by transaction count in the selected area and date range.</p></div></div>
    <div className="performance-agent-columns">
      {[['Best transacting agents', performance.best || []], ['Needs attention', performance.needsAttention || []]].map(([title, agents]) => <div key={title}><h4>{title}</h4>{agents.length ? <ol>{agents.map((agent) => <li key={agent.id}><span className="performance-copy"><button className="performance-agent-open" type="button" onClick={() => navigate(`${agentPath}${encodeURIComponent(agent.id)}`)}>{agent.name}</button><small>{[agent.district, agent.sector, agent.cell, agent.village].filter(Boolean).join(' · ') || 'Location not available'}</small></span><span className="performance-count"><strong>{number(agent.transactionCount ?? agent.reportedDepositCount)}</strong><small>transactions</small></span></li>)}</ol> : <p className="detail-empty">No agents are available in this selection.</p>}</div>)}
    </div>
  </section>;
}

export function OverviewAgentResults({ network, status, filters, onClose }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [sortBy, setSortBy] = useState('transactions');
  const [sortDirection, setSortDirection] = useState('desc');
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const endpoint = network === 'MOOLA_PLUS' ? '/api/v1/reports/moola-plus/agents' : '/api/v1/reports/irembo/agents';
  useEffect(() => setPage(1), [status, network, filters.province, filters.district, filters.sector, filters.cell, filters.village, filters.fromDate, filters.toDate]);
  useEffect(() => {
    const controller = new AbortController();
    const params = { page, limit: 10, ...filters, sortBy, sortDirection };
    if (status) params.status = status;
    setLoading(true); setError('');
    api.get(endpoint, { params, signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return;
      setRows(data.data || []); setPages(data.pages || 0); setTotal(data.total || 0);
    }).catch((err) => { if (!controller.signal.aborted) setError(err.response?.data?.error || 'Could not load agents for this selection.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, page, status, filters, sortBy, sortDirection]);

  const downloadResults = async () => {
    setDownloading(true);
    setError('');
    try {
      const { data } = await api.get(endpoint, { params: { ...filters, ...(status ? { status } : {}), sortBy, sortDirection, download: 'csv' }, responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${network.toLocaleLowerCase()}-${String(status || 'agents').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError('Could not download the agents for these filters.');
    } finally { setDownloading(false); }
  };

  return <section className="surface-card overview-agent-results">
    <div className="overview-results-heading"><div><h3>{number(total)} matching agents</h3><p>{status ? `${status} agents` : 'Agents'} · filtered by the selected territory and time frame.</p></div><div className="overview-results-tools"><label>Sort by<select className="input" value={sortBy} onChange={(event) => { setSortBy(event.target.value); setPage(1); }}><option value="transactions">Transactions</option><option value="name">Name</option><option value="activity">Activity status</option><option value="registrationDate">Registration date</option></select></label><label>Order<select className="input" value={sortDirection} onChange={(event) => { setSortDirection(event.target.value); setPage(1); }}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label><button className="btn btn-secondary btn-sm" type="button" onClick={downloadResults} disabled={downloading || loading || !total}><Download size={15} />{downloading ? 'Preparing…' : 'Download CSV'}</button><button className="subtle-link" type="button" onClick={onClose}>Close list</button></div></div>
    {error && <ErrorState message={error} />}
    {loading ? <LoadingState message="Loading matching agents…" /> : rows.length ? <>
      <div className="table-scroll"><table className="data-table overview-results-table"><thead><tr><th>Agent</th><th>Activity</th><th>Transactions</th><th>Province · District</th><th>Sector · Cell · Village</th><th><span className="sr-only">Open profile</span></th></tr></thead><tbody>{rows.map((agent) => <tr key={agent.id} onClick={() => navigate(network === 'MOOLA_PLUS' ? `/moola-plus/agents/${encodeURIComponent(agent.id)}` : `/irembo/agents/${encodeURIComponent(agent.id)}`)} tabIndex="0" onKeyDown={(event) => event.key === 'Enter' && navigate(network === 'MOOLA_PLUS' ? `/moola-plus/agents/${encodeURIComponent(agent.id)}` : `/irembo/agents/${encodeURIComponent(agent.id)}`)}>
        <td><strong>{agent.name || agent.loginName || 'Agent'}</strong><small className="visit-subtext">{agent.loginName || agent.agentId || '—'}</small></td><td><span className={`moola-status-pill status-${statusClass(agent.activityStatus)}`}>{agent.activityStatus}</span></td><td>{number(agent.transactionCount ?? agent.reportedDepositCount)}</td><td>{[agent.province, agent.district].filter(Boolean).join(' · ') || '—'}</td><td>{[agent.sector, agent.cell, agent.village].filter(Boolean).join(' · ') || '—'}</td><td><ArrowRight size={16} /></td>
      </tr>)}</tbody></table></div>
      <div className="overview-results-footer"><span>Showing {(page - 1) * 10 + 1}–{Math.min(page * 10, total)} of {number(total)}</span><div><button type="button" className="agent-page-button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} aria-label="Previous page"><ChevronLeft size={17} /></button><span>Page {page} of {Math.max(1, pages)}</span><button type="button" className="agent-page-button" disabled={page >= pages} onClick={() => setPage((current) => Math.min(pages, current + 1))} aria-label="Next page"><ChevronRight size={17} /></button></div></div>
    </> : <div className="detail-empty">No agents match these filters.</div>}
  </section>;
}
