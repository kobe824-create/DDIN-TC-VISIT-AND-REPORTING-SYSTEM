import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, ArrowUpRight, BadgeCheck, CalendarDays,
  ClipboardCheck, Clock3, MapPin, Plus, RefreshCw, ShieldAlert, UsersRound
} from 'lucide-react';
import api from '../api';
import { useAuth } from '../AuthContext';
import { ErrorState, ListPagination, LoadingState, StatusBadge } from '../components';
import MoolaAnalytics from '../components/MoolaAnalytics';
import IremboActivity from '../components/IremboActivity';
import { OverviewAgentResults, OverviewFilters, PerformanceRanking } from '../components/NetworkOverview';
import { MOOLA_PLUS_NETWORK, useNetwork } from '../NetworkContext';

const formatDate = (value, options) => value ? new Intl.DateTimeFormat('en-GB', options).format(new Date(value)) : '—';
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
  const { network } = useNetwork();
  const navigate = useNavigate();
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [territoryFilters, setTerritoryFilters] = useState({ province: '', district: '', sector: '', cell: '', village: '' });
  const [selectedStatus, setSelectedStatus] = useState('');
  const [iremboSummary, setIremboSummary] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [moolaSummary, setMoolaSummary] = useState(null);
  const [moolaLoading, setMoolaLoading] = useState(false);
  const [moolaError, setMoolaError] = useState('');
  const [moolaVisitSummary, setMoolaVisitSummary] = useState(null);
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
  const dashboardRequest = useRef(0);
  const role = user?.role?.toUpperCase();
  const canStartVisit = role === 'TC';
  const agentFilters = useMemo(() => ({ ...territoryFilters, fromDate, toDate }), [territoryFilters, fromDate, toDate]);
  const updateAgentFilters = (next) => {
    setTerritoryFilters({ province: next.province || '', district: next.district || '', sector: next.sector || '', cell: next.cell || '', village: next.village || '' });
    setFromDate(next.fromDate || '');
    setToDate(next.toDate || '');
    setVisitPage(1);
  };
  const receiveIremboSummary = useCallback((data) => setIremboSummary(data), []);

  const loadDashboard = useCallback(async () => {
    const requestId = ++dashboardRequest.current;
    if (initialDashboardLoad.current) setLoading(true);
    setError('');
    try {
      const params = { fromDate: fromDate || undefined, toDate: toDate || undefined };
      const { data } = await api.get('/api/v1/reports/dashboard', { params });
      if (requestId !== dashboardRequest.current) return;
      setDashboard(data);
      initialDashboardLoad.current = false;
    } catch (err) {
      if (requestId === dashboardRequest.current) setError(err.response?.data?.error || err.message || 'The dashboard could not be loaded.');
    } finally {
      if (requestId === dashboardRequest.current) setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    if (network === 'IREMBO') loadDashboard();
  }, [loadDashboard, network]);

  const loadMoolaSummary = useCallback(async (forceRefresh = false) => {
    setMoolaLoading(true);
    setMoolaError('');
    try {
      const { data } = await api.get('/api/v1/reports/moola-plus/summary', { params: { ...agentFilters, ...(forceRefresh ? { refresh: 'true' } : {}) } });
      setMoolaSummary(data);
    } catch (err) {
      setMoolaError(err.response?.data?.error || err.message || 'The DDIN Moola+ registry could not be loaded.');
    } finally {
      setMoolaLoading(false);
    }
  }, [agentFilters]);

  useEffect(() => {
    if (network === 'MOOLA_PLUS') loadMoolaSummary();
  }, [loadMoolaSummary, network]);

  const activeRange = dashboard?.selectedRange;

  useEffect(() => {
    if (network !== 'MOOLA_PLUS' && (!activeRange?.fromDate || !activeRange?.toDate)) return undefined;
    const controller = new AbortController();
    setVisitsLoading(true);
    setVisitsError('');
    const params = network === 'MOOLA_PLUS'
      ? { network, page: visitPage, limit: visitPageSize }
      : { network, page: visitPage, limit: visitPageSize, fromDate: activeRange.fromDate, toDate: activeRange.toDate };
    api.get('/api/v1/reports/visits', { params, signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        setVisits(data.data || []);
        setVisitTotal(data.meta?.total ?? 0);
        setVisitPages(data.meta?.pages ?? 0);
        setVisitPage(data.meta?.page ?? visitPage);
        if (network === 'MOOLA_PLUS') setMoolaVisitSummary(data.summary || null);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setVisitsError(err.response?.data?.error || 'Could not load recent visits.');
    })
      .finally(() => { if (!controller.signal.aborted) setVisitsLoading(false); });
    return () => controller.abort();
  }, [activeRange?.fromDate, activeRange?.toDate, network, visitPage, visitPageSize, visitsRetryKey]);

  useEffect(() => {
    if (visitPage > Math.max(visitPages, 1)) setVisitPage(Math.max(visitPages, 1));
  }, [visitPage, visitPages]);

  const stats = dashboard?.stats?.selected || {};
  const flagged = Number(stats.flaggedVisitsCount || 0);
  const verifiedRate = valueOrZero(stats.verifiedVisitRate);
  const greetingName = user?.firstName || user?.name || user?.username || 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const activityDescription = dashboard?.selectedRange
    ? `Showing activity from ${formatDate(`${dashboard.selectedRange.fromDate}T00:00:00`, { day: 'numeric', month: 'short', year: 'numeric' })} through ${formatDate(`${dashboard.selectedRange.toDate}T00:00:00`, { day: 'numeric', month: 'short', year: 'numeric' })}.`
    : 'Choose a date range for dashboard activity.';

  return <div className="dashboard-page">
    <section className="welcome-panel">
      <div className="welcome-copy">
        <span className="welcome-kicker"><CalendarDays size={14} /> {new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</span>
        <h2>{greeting}, {greetingName}</h2>
        <p>{network === MOOLA_PLUS_NETWORK ? 'Moola Plus agents and reported deposit activity are loaded from the DDIN registry within your authorized coverage.' : `${activityDescription} Irembo agent status and field activity cover your authorized areas.`}</p>
      </div>
      <div className="welcome-actions dashboard-range-controls">
        {canStartVisit && <button className="btn btn-primary" onClick={() => navigate('/visits/new')}><Plus size={17} />Start a visit</button>}
        {network === MOOLA_PLUS_NETWORK && <button className="btn btn-secondary" onClick={() => loadMoolaSummary(true)} disabled={moolaLoading}><RefreshCw size={16} className={moolaLoading ? 'spin' : ''} />Refresh registry</button>}
      </div>
    </section>

    {network === MOOLA_PLUS_NETWORK ? <section className="moola-overview">
      {moolaError && <ErrorState message={moolaError} onRetry={loadMoolaSummary} />}
      {moolaLoading && !moolaSummary ? <LoadingState type="cards" message="Loading the DDIN Moola+ registry…" /> : moolaSummary && <>
        <OverviewFilters network="Moola Plus" options={moolaSummary.filters} value={agentFilters} onChange={(next) => { updateAgentFilters(next); setSelectedStatus(''); }} />
        <div className="network-source-note">
          <strong>DDIN registry data</strong>
          <span>{moolaSummary.stale ? 'Showing the last successful registry sync.' : 'Agent list refreshes from the DDIN API and is cached briefly.'}</span>
          {moolaSummary.fetchedAt && <small>Last synced {formatDate(moolaSummary.fetchedAt, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kigali' })} Rwanda time</small>}
        </div>
        <MoolaAnalytics summary={moolaSummary} selectedStatus={selectedStatus} onStatusSelect={setSelectedStatus} />
        {selectedStatus && <OverviewAgentResults network="MOOLA_PLUS" status={selectedStatus} filters={agentFilters} onClose={() => setSelectedStatus('')} />}
        <PerformanceRanking performance={moolaSummary.performance} network="Moola Plus" filters={agentFilters} showTcCoverage={['ADMIN', 'MANAGER'].includes(role)} />
        <section className="moola-field-activity" aria-label="Moola Plus field visit activity">
          <div className="metric-grid">
            <MetricCard index="M1" label="Counted Moola visits" value={Number(moolaVisitSummary?.total || 0).toLocaleString()} caption="Within the three-month agent window" />
            <MetricCard index="M2" label="Agents visited" value={Number(moolaVisitSummary?.uniqueAgentsVisited || 0).toLocaleString()} caption="Completed visits included in metrics" />
            <MetricCard index="M3" label="Follow-up visits" value={Number(moolaVisitSummary?.followUps || 0).toLocaleString()} caption="Kept in visit history, excluded from totals" />
            <MetricCard index="M4" label="GPS verified" value={Number(moolaVisitSummary?.verified || 0).toLocaleString()} caption="Counted completed visits with verified GPS" />
          </div>
          <section className="surface-card recent-visits-card">
            <div className="surface-heading"><div><span className="section-kicker">MOOLA PLUS FIELD ACTIVITY</span><h3>Recent visits</h3><p>Visit records use DDIN agent IDs and remain separate from the Irembo roster.</p></div><button className="btn btn-secondary btn-sm" onClick={() => navigate('/visits')}>All Moola visits <ArrowRight size={14} /></button></div>
            {visitsLoading ? <LoadingState message="Loading Moola Plus visits…" /> : visitsError ? <ErrorState message={visitsError} onRetry={() => setVisitsRetryKey((key) => key + 1)} /> : visits.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Agent</th><th>Visit</th><th>Coordinator</th><th>Status</th><th>Date</th></tr></thead><tbody>{visits.map((visit) => <tr key={visit.id} onClick={() => navigate(`/visits/${visit.id}`)}><td><strong>{visit.externalAgentName || visit.agent?.name || 'Moola Plus agent'}</strong><small className="visit-subtext">{visit.externalAgentCode || visit.agent?.agentId || '—'}</small></td><td>{visit.visitId}{visit.countsForMetrics === false && <small className="metric-exclusion-note">Follow-up · excluded</small>}</td><td>{personName(visit.tc)}</td><td><StatusBadge status={visit.visitStatus} /></td><td>{formatDate(visit.visitDate || visit.checkInTime, { day: '2-digit', month: 'short', year: 'numeric' })}</td></tr>)}</tbody></table></div> : <div className="detail-empty">No Moola Plus visits have been recorded in this period.</div>}
            {visitPages > 1 && <ListPagination page={visitPage} pages={visitPages} total={visitTotal} pageSize={visitPageSize} onPageChange={setVisitPage} onPageSizeChange={(value) => { setVisitPageSize(value); setVisitPage(1); }} />}
          </section>
        </section>
      </>}
    </section> : loading && !dashboard ? <LoadingState type="cards" message="Loading your Irembo overview…" /> : error && !dashboard ? <ErrorState message={error} onRetry={loadDashboard} /> : <>
    {error && <ErrorState message={error} onRetry={loadDashboard} />}
    <OverviewFilters network="Irembo" options={iremboSummary?.filters} value={agentFilters} onChange={(next) => { updateAgentFilters(next); setSelectedStatus(''); }} />
    <IremboActivity filters={agentFilters} selectedStatus={selectedStatus} onStatusSelect={setSelectedStatus} onSummary={receiveIremboSummary} />
    {selectedStatus && <OverviewAgentResults network="IREMBO" status={selectedStatus} filters={agentFilters} onClose={() => setSelectedStatus('')} />}
    <PerformanceRanking performance={iremboSummary?.performance} network="Irembo" filters={agentFilters} showTcCoverage={['ADMIN', 'MANAGER'].includes(role)} />

    <section className="metric-grid" aria-label="Irembo field activity">
      <MetricCard index="01" label="Visits counted" value={stats.totalVisits ?? 0} caption={`${stats.completedVisits ?? 0} completed in this period`} />
      <MetricCard index="02" label="Verified visits" value={`${verifiedRate.toFixed(0)}%`} caption="Location checks passed" />
      <MetricCard index="03" label="Needs review" value={flagged} caption="Outside the allowed radius" />
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
            <td><StatusBadge status={visit.visitStatus} />{visit.countsForMetrics === false && <small className="metric-exclusion-note">Follow-up · excluded from metrics</small>}</td>
            <td><span className={`location-result ${visit.locationStatus === 'VERIFIED' ? 'verified' : 'needs-review'}`}><span />{(visit.locationStatus || 'UNKNOWN').replaceAll('_', ' ')}</span></td>
            <td className="date-cell">{formatDate(visit.visitDate || visit.checkInTime, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
            <td><ArrowRight className="row-arrow" size={16} /></td>
          </tr>)}</tbody>
        </table></div> : <div className="table-empty"><div className="empty-mark"><ClipboardCheck size={21} /></div><strong>No visits recorded yet</strong><span>Once field visits are submitted, they’ll appear here.</span>{canStartVisit && <button className="btn btn-secondary btn-sm" onClick={() => navigate('/visits/new')}>Start first visit</button>}</div>}
        {visitTotal > 0 && <ListPagination page={visitPage} pages={visitPages} total={visitTotal} pageSize={visitPageSize} onPageChange={setVisitPage} onPageSizeChange={(value) => { setVisitPageSize(value); setVisitPage(1); }} />}
        {!visitsError && !visitsLoading && visits.length > 0 && <div className="card-footnote"><Clock3 size={14} /><span>Visits are ordered newest first.</span></div>}
      </article>

      <aside className="dashboard-side-column">
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
    <footer className="dashboard-footer"><span>Irembo field activity</span><span>Visit activity is scoped to your authorized areas. Follow-up visits within three months are kept in history but excluded from performance metrics.</span></footer>
    </>}
  </div>;
}
