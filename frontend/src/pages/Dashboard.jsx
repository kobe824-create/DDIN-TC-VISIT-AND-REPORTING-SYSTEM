import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, ArrowUpRight, BadgeCheck, CalendarDays,
  ClipboardCheck, Clock3, MapPin, Plus, ShieldAlert, UsersRound
} from 'lucide-react';
import api from '../api';
import { useAuth } from '../AuthContext';
import { ErrorState, ListPagination, LoadingState, StatusBadge } from '../components';

const periods = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'thisWeek', label: 'This week' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'customDate', label: 'Choose a date…' },
];

const formatDate = (value, options) => value ? new Intl.DateTimeFormat('en-GB', options).format(new Date(value)) : '—';
const localDateValue = (date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};
const personName = (person) => [person?.firstName, person?.lastName].filter(Boolean).join(' ') || person?.username || '—';
const valueOrZero = (value) => Number.parseFloat(value || 0) || 0;

function MetricCard({ index, label, value, caption }) {
  return <article className="metric-card">
    <span className="metric-index" aria-hidden="true">{index}</span>
    <div className="metric-content"><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-caption">{caption}</span></div>
  </article>;
}

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [period, setPeriod] = useState('today');
  const [selectedDate, setSelectedDate] = useState(() => localDateValue(new Date()));
  const [dashboard, setDashboard] = useState(null);
  const [visits, setVisits] = useState([]);
  const [visitTotal, setVisitTotal] = useState(0);
  const [visitPages, setVisitPages] = useState(0);
  const [visitPage, setVisitPage] = useState(1);
  const [visitPageSize, setVisitPageSize] = useState(10);
  const [visitsRetryKey, setVisitsRetryKey] = useState(0);
  const [visitsLoading, setVisitsLoading] = useState(true);
  const [visitsError, setVisitsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const initialDashboardLoad = useRef(true);
  const role = user?.role?.toUpperCase();
  const canStartVisit = role === 'TC';

  const loadDashboard = useCallback(async () => {
    if (initialDashboardLoad.current) setLoading(true);
    setError('');
    try {
      const params = { period, ...(period === 'customDate' ? { date: selectedDate } : {}) };
      const { data } = await api.get('/api/v1/reports/dashboard', { params });
      setDashboard(data);
      initialDashboardLoad.current = false;
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'The dashboard could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [period, selectedDate]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const activeRange = period === 'customDate' && dashboard?.selectedDate !== selectedDate
    ? null
    : dashboard?.dateRanges?.[period];

  useEffect(() => {
    if (!activeRange?.fromDate || !activeRange?.toDate) return undefined;
    const controller = new AbortController();
    setVisitsLoading(true);
    setVisitsError('');
    api.get('/api/v1/visits', { params: { page: visitPage, limit: visitPageSize, fromDate: activeRange.fromDate, toDate: activeRange.toDate }, signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        setVisits(data.data || []);
        setVisitTotal(data.meta?.total ?? 0);
        setVisitPages(data.meta?.pages ?? 0);
        setVisitPage(data.meta?.page ?? visitPage);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setVisitsError(err.response?.data?.error || 'Could not load recent visits.');
    })
      .finally(() => { if (!controller.signal.aborted) setVisitsLoading(false); });
    return () => controller.abort();
  }, [activeRange?.fromDate, activeRange?.toDate, visitPage, visitPageSize, visitsRetryKey]);

  useEffect(() => {
    if (visitPage > Math.max(visitPages, 1)) setVisitPage(Math.max(visitPages, 1));
  }, [visitPage, visitPages]);

  const stats = period === 'customDate' && dashboard?.selectedDate !== selectedDate
    ? {}
    : dashboard?.stats?.[period] || {};
  const flagged = Number(stats.flaggedVisitsCount || 0);
  const verifiedRate = valueOrZero(stats.verifiedVisitRate);
  const greetingName = user?.firstName || user?.name || user?.username || 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const activityDescription = period === 'yesterday'
    ? 'Showing activity recorded yesterday.'
    : period === 'thisWeek'
      ? 'Showing activity recorded this week.'
      : period === 'thisMonth'
        ? 'Showing activity recorded this month.'
        : period === 'customDate'
          ? `Showing activity recorded on ${formatDate(`${selectedDate}T00:00:00`, { day: 'numeric', month: 'long', year: 'numeric' })}.`
          : 'Showing activity recorded today.';

  if (loading) return <div className="dashboard-page"><LoadingState type="cards" message="Loading your operations overview…" /></div>;
  if (error && !dashboard) return <div className="dashboard-page"><ErrorState message={error} onRetry={loadDashboard} /></div>;

  return <div className="dashboard-page">
    <section className="welcome-panel">
      <div className="welcome-copy">
        <span className="welcome-kicker"><CalendarDays size={14} /> {new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</span>
        <h2>{greeting}, {greetingName}</h2>
        <p>{activityDescription} Data covers your authorized areas.</p>
      </div>
      <div className={`welcome-actions${period === 'customDate' ? ' has-custom-date' : ''}`}>
        <label className="period-select-wrap" htmlFor="dashboard-period"><span className="sr-only">Reporting period</span>
          <select id="dashboard-period" className="period-select" value={period} onChange={(event) => { setPeriod(event.target.value); setVisitPage(1); }}>
            {periods.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}
          </select>
        </label>
        {period === 'customDate' && <label className="dashboard-date-wrap" htmlFor="dashboard-date">
          <span className="sr-only">Choose activity date</span>
          <input id="dashboard-date" className="period-select period-date-input" type="date" value={selectedDate} max={localDateValue(new Date())} onChange={(event) => { if (event.target.value) { setSelectedDate(event.target.value); setVisitPage(1); } }} />
        </label>}
        {canStartVisit && <button className="btn btn-primary" onClick={() => navigate('/visits/new')}><Plus size={17} />Start a visit</button>}
      </div>
    </section>
    {error && <ErrorState message={error} onRetry={loadDashboard} />}

    <section className="metric-grid" aria-label="Field performance">
      <MetricCard index="01" label="Visits recorded" value={stats.totalVisits ?? 0} caption={`${stats.completedVisits ?? 0} completed in this period`} />
      <MetricCard index="02" label="Active agents" value={stats.totalActiveAgents ?? 0} caption="Across authorized territories" />
      <MetricCard index="03" label="Verified visits" value={`${verifiedRate.toFixed(0)}%`} caption="Location checks passed" />
      <MetricCard index="04" label="Needs review" value={flagged} caption="Outside the allowed radius" />
    </section>

    <section className="surface-card field-activity-card" aria-label="First visit and territory changes">
      <div className="surface-heading">
        <div><span className="section-kicker">AGENT LOCATION HISTORY</span><h3>First visits and transfers</h3><p>{activityDescription} {role === 'ADMIN' ? 'Showing TC actions across all territories.' : 'Showing your recorded actions.'}</p></div>
        <span className="coverage-icon"><MapPin size={17} /></span>
      </div>
      {dashboard?.fieldActivity?.length ? <ul className="field-activity-list">
        {dashboard.fieldActivity.map((entry) => {
          const location = [entry.territoryName, entry.sectorName, entry.cellName, entry.villageName].filter(Boolean).join(' · ');
          return <li className="field-activity-row" key={entry.id}>
            <span className="field-activity-mark"><MapPin size={16} /></span>
            <div className="field-activity-copy"><strong>{entry.label}</strong><span>{entry.agentName}{entry.agentCode ? ` · ${entry.agentCode}` : ''}</span>
              <small>{location || 'Territory details not recorded'}{role === 'ADMIN' ? ` · ${entry.tcName}` : ''} · {formatDate(entry.createdAt, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
            </div>
          </li>;
        })}
      </ul> : <div className="field-activity-empty">No first-visit location or transfer updates were recorded in this period.</div>}
    </section>

    <section className="dashboard-columns">
      <article className="surface-card visits-card">
        <div className="surface-heading">
          <div><span className="section-kicker">FIELD ACTIVITY</span><h3>Recent visits</h3><p>{activityDescription}</p></div>
          <button className="text-link" onClick={() => navigate('/visits')}>All visits <ArrowRight size={15} /></button>
        </div>
        {visitsLoading ? <LoadingState message="Loading visits…" /> : visitsError ? <ErrorState message={visitsError} onRetry={() => setVisitsRetryKey((key) => key + 1)} /> : visits.length ? <div className="table-scroll"><table className="data-table dashboard-table">
          <thead><tr><th>Agent</th><th>Coordinator</th><th>Visit status</th><th>Location check</th><th>When</th><th><span className="sr-only">Open record</span></th></tr></thead>
          <tbody>{visits.map((visit) => <tr key={visit.id} onClick={() => navigate(`/visits/${visit.id}`)} tabIndex="0" onKeyDown={(event) => event.key === 'Enter' && navigate(`/visits/${visit.id}`)}>
            <td><div className="table-person"><span className="table-avatar">{(visit.agent?.name || 'A').slice(0, 1).toUpperCase()}</span><span><strong>{visit.agent?.name || 'Unknown agent'}</strong><small>{visit.agent?.agentId || visit.visitId || 'Agent record'}</small></span></div></td>
            <td>{personName(visit.tc)}</td>
            <td><StatusBadge status={visit.visitStatus} /></td>
            <td><span className={`location-result ${visit.locationStatus === 'VERIFIED' ? 'verified' : 'needs-review'}`}><span />{(visit.locationStatus || 'UNKNOWN').replaceAll('_', ' ')}</span></td>
            <td className="date-cell">{formatDate(visit.visitDate || visit.checkInTime, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
            <td><ArrowRight className="row-arrow" size={16} /></td>
          </tr>)}</tbody>
        </table></div> : <div className="table-empty"><div className="empty-mark"><ClipboardCheck size={21} /></div><strong>No visits recorded yet</strong><span>Once field visits are submitted, they’ll appear here.</span>{canStartVisit && <button className="btn btn-secondary btn-sm" onClick={() => navigate('/visits/new')}>Start first visit</button>}</div>}
        {visitTotal > 0 && <ListPagination page={visitPage} pages={visitPages} total={visitTotal} pageSize={visitPageSize} onPageChange={setVisitPage} onPageSizeChange={(value) => { setVisitPageSize(value); setVisitPage(1); }} />}
        {!visitsError && !visitsLoading && visits.length > 0 && <div className="card-footnote"><Clock3 size={14} /><span>Visits are ordered newest first.</span></div>}
      </article>

      <aside className="dashboard-side-column">
        <article className="surface-card coverage-card">
          <div className="surface-heading compact"><div><span className="section-kicker">COVERAGE</span><h3>Territory coverage</h3></div><span className="coverage-icon"><UsersRound size={17} /></span></div>
          <div className="coverage-value">{stats.coverageRate || '0%'}</div>
          <p className="coverage-copy">Active agents visited during the selected period.</p>
          <div className="coverage-track"><span style={{ width: `${Math.min(100, valueOrZero(stats.coverageRate))}%` }} /></div>
          <div className="coverage-legend"><span><i className="legend-dot orange-dot" />Visited agents</span><span>{stats.totalActiveAgents || 0} active</span></div>
          <button className="subtle-link" onClick={() => navigate('/reports')}>Explore coverage report <ArrowRight size={15} /></button>
        </article>

        <article className={`review-card ${flagged ? 'has-flags' : ''}`}>
          <div className="review-top"><span className="review-icon">{flagged ? <ShieldAlert size={18} /> : <BadgeCheck size={18} />}</span><span className="review-label">VISIT INTEGRITY</span>{flagged > 0 && <span className="review-count">{flagged}</span>}</div>
          <h3>{flagged ? 'Visits to review' : 'All clear for now'}</h3>
          <p>{flagged ? 'Some recent visits were recorded outside the configured geofence.' : 'No outside-radius visits were recorded in this period.'}</p>
          {flagged > 0 && <button onClick={() => navigate('/visits?status=FLAGGED')}>Review flagged visits <ArrowRight size={15} /></button>}
          {flagged === 0 && <div className="integrity-rate"><span>Verified visit rate</span><strong>{verifiedRate.toFixed(0)}%</strong><ArrowUpRight size={16} /></div>}
        </article>

        <article className="quick-actions-card">
          <div className="quick-actions-heading"><span className="section-kicker">SHORTCUTS</span><h3>Move work forward</h3></div>
          {canStartVisit && <button onClick={() => navigate('/visits/new')}><span className="shortcut-icon orange-shortcut"><MapPin size={17} /></span><span><strong>Record a visit</strong><small>Capture GPS, evidence and report</small></span><ArrowRight size={16} /></button>}
          <button onClick={() => navigate('/agents')}><span className="shortcut-icon blue-shortcut"><UsersRound size={17} /></span><span><strong>Find an agent</strong><small>Browse agents in your assigned areas</small></span><ArrowRight size={16} /></button>
          <button onClick={() => navigate('/reports')}><span className="shortcut-icon green-shortcut"><ClipboardCheck size={17} /></span><span><strong>Open reports</strong><small>Review coverage and outcomes</small></span><ArrowRight size={16} /></button>
        </article>
      </aside>
    </section>
    <footer className="dashboard-footer"><span>Operational overview</span><span>Field visit data is recorded for authorized roles only.</span></footer>
  </div>;
}
