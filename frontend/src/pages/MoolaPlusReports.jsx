import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRightLeft, MapPin, RefreshCw, UsersRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import MoolaAnalytics from '../components/MoolaAnalytics';
import PageHeader from '../components/PageHeader';
import { ErrorState, LoadingState, StatusBadge } from '../components';
import { useAuth } from '../AuthContext';

const formatDate = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Kigali' }).format(new Date(value)) : '—';
const dateToday = () => new Date().toISOString().slice(0, 10);
const dateMonthStart = () => `${dateToday().slice(0, 7)}-01`;
const movementStatus = (event) => event.status === 'ACCEPTED_GPS_PENDING' ? 'Accepted · first visit GPS pending' : event.status === 'PENDING' ? (event.kind === 'TRANSFER' ? 'Awaiting TC review' : 'Awaiting admin review') : String(event.status || '').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());

export default function MoolaPlusReports() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [summary, setSummary] = useState(null);
  const [visitSummary, setVisitSummary] = useState(null);
  const [recentVisits, setRecentVisits] = useState([]);
  const [visitError, setVisitError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [movementFromDate, setMovementFromDate] = useState(dateMonthStart());
  const [movementToDate, setMovementToDate] = useState(dateToday());
  const [movementReport, setMovementReport] = useState(null);
  const [movementLoading, setMovementLoading] = useState(false);
  const [movementError, setMovementError] = useState('');
  const [movementUpdatedAt, setMovementUpdatedAt] = useState(null);
  const movementRequestIdRef = useRef(0);
  const movementRequestActiveRef = useRef(false);
  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/api/v1/reports/moola-plus/summary', { params: forceRefresh ? { refresh: 'true' } : undefined });
      setSummary(data);
      try {
        const { data: visits } = await api.get('/api/v1/reports/visits', { params: { network: 'MOOLA_PLUS', limit: 8, page: 1 } });
        setVisitSummary(visits.summary || null);
        setRecentVisits(visits.data || []);
        setVisitError('');
      } catch (visitFetchError) {
        setVisitError(visitFetchError.response?.data?.error || 'Could not load Moola Plus field visits.');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load Moola Plus activity reports.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const loadMovements = useCallback(async ({ silent = false } = {}) => {
    if (!isAdmin) return;
    if (silent && movementRequestActiveRef.current) return;
    const requestId = ++movementRequestIdRef.current;
    movementRequestActiveRef.current = true;
    if (!silent) {
      setMovementLoading(true);
      setMovementError('');
    }
    try {
      const { data } = await api.get('/api/v1/reports/moola-plus/movements', { params: { fromDate: movementFromDate, toDate: movementToDate, _refresh: Date.now() } });
      if (requestId !== movementRequestIdRef.current) return;
      setMovementReport(data);
      setMovementUpdatedAt(Date.now());
      setMovementError('');
    } catch (movementLoadError) {
      if (!silent && requestId === movementRequestIdRef.current) setMovementError(movementLoadError.response?.data?.error || 'Could not load Moola Plus movement activity.');
    } finally {
      if (requestId === movementRequestIdRef.current) {
        movementRequestActiveRef.current = false;
        if (!silent) setMovementLoading(false);
      }
    }
  }, [isAdmin, movementFromDate, movementToDate]);
  useEffect(() => { if (isAdmin) void loadMovements(); }, [isAdmin, loadMovements]);
  useEffect(() => {
    if (!isAdmin) return undefined;
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') void loadMovements({ silent: true });
    };
    const interval = window.setInterval(refreshIfVisible, 10000);
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [isAdmin, loadMovements]);

  return <div className="page moola-reports-page">
    <PageHeader title="Moola Plus reports" subtitle="Agent activity and classifications from DDIN’s registry and deposit report." actions={<div className="page-header-actions"><button className="btn btn-secondary" onClick={() => navigate('/agents')}><UsersRound size={16} />Browse agents</button><button className="btn btn-primary" onClick={() => load(true)} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} />Refresh</button></div>} />
    {error && <ErrorState message={error} onRetry={load} />}
    {loading && !summary ? <LoadingState type="cards" message="Loading Moola Plus reports…" /> : summary && <>
      <div className="network-source-note"><strong>{summary.stale ? 'Showing the last successful sync' : 'Live DDIN registry data'}</strong><span>Last synced {formatDate(summary.fetchedAt)} Rwanda time.</span></div>
      <MoolaAnalytics summary={summary} />
      {isAdmin && <section className="surface-card moola-movement-report">
        <div className="surface-heading"><div><span className="section-kicker">TERRITORY CHANGES</span><h3>Moola Plus transfers and relocations</h3><p>Includes same-village venue assignments saved by coordinators.</p><small className="movement-live-label" aria-live="polite" title="Automatically refreshes every 10 seconds while this page is visible.">{movementUpdatedAt ? `Live · updated ${timeLabel(movementUpdatedAt)} Rwanda time` : 'Updating…'}</small></div><div className="page-header-actions"><label className="movement-date-filter"><span>From</span><input type="date" value={movementFromDate} onChange={(event) => setMovementFromDate(event.target.value)} /></label><label className="movement-date-filter"><span>To</span><input type="date" value={movementToDate} onChange={(event) => setMovementToDate(event.target.value)} /></label><button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadMovements({ silent: true })} disabled={movementLoading}><RefreshCw size={15} />Refresh</button></div></div>
        {movementError && <ErrorState message={movementError} onRetry={loadMovements} />}
        {movementLoading ? <LoadingState message="Loading Moola Plus moves…" /> : !movementError && <>
          <section className="report-metrics movement-metrics">
            <div><span className="report-metric-icon orange"><ArrowRightLeft size={16} /></span><span><small>Transfer requests</small><strong>{Number(movementReport?.summary?.transferRequests || 0).toLocaleString()}</strong><em>{Number(movementReport?.summary?.transfersCompleted || 0).toLocaleString()} completed</em></span></div>
            <div><span className="report-metric-icon amber"><MapPin size={16} /></span><span><small>Relocations + venue assignments</small><strong>{Number(movementReport?.summary?.relocationsIncludingVenueAssignments ?? movementReport?.summary?.relocations ?? 0).toLocaleString()}</strong><em>{Number(movementReport?.summary?.relocations || 0).toLocaleString()} requests · {Number(movementReport?.summary?.venueAssignments || 0).toLocaleString()} venue updates</em></span></div>
            <div><span className="report-metric-icon blue"><UsersRound size={16} /></span><span><small>Admin relocations</small><strong>{Number(movementReport?.summary?.adminRelocations || 0).toLocaleString()}</strong><em>{Number(movementReport?.summary?.relocationsAwaitingReview || 0).toLocaleString()} awaiting review</em></span></div>
          </section>
          <div className="table-scroll"><table className="data-table report-table movement-table"><thead><tr><th>Type</th><th>Agent & login</th><th>From</th><th>To</th><th>Requested by</th><th>Reviewed by</th><th>Status</th><th>Date</th></tr></thead><tbody>
            {(movementReport?.events || []).map((event) => <tr key={event.id} className="movement-report-row" tabIndex={0} role="link" onClick={() => navigate(`/reports/movements/${encodeURIComponent(event.id)}`)} onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter' || keyEvent.key === ' ') { keyEvent.preventDefault(); navigate(`/reports/movements/${encodeURIComponent(event.id)}`); } }}><td>{event.kind === 'TRANSFER' ? 'Transfer' : event.kind === 'VENUE_ASSIGNMENT' || event.changeType === 'VENUE_ASSIGNMENT' ? 'Venue assignment' : event.kind === 'RELOCATION' ? 'TC relocation' : 'Admin relocation'}</td><td><strong>{event.agentName}</strong><small className="visit-subtext">{event.agentNumber}</small></td><td>{event.from}</td><td>{event.to}</td><td>{event.requestedBy}</td><td>{event.reviewedBy}</td><td><span className={`movement-status ${String(event.status).toLowerCase().replaceAll('_', '-')}`}>{movementStatus(event)}</span></td><td>{formatDate(event.requestedAt)}</td></tr>)}
            {!movementReport?.events?.length && <tr><td className="report-empty" colSpan="8">No Moola Plus transfers or relocations were recorded during this period.</td></tr>}
          </tbody></table></div>
          {movementReport?.eventLimitReached && <p className="card-footnote">Showing the latest 1,000 movement records in this period.</p>}
        </>}
      </section>}
      <section className="moola-analytics moola-report-visits">
        <div className="surface-heading"><div><span className="section-kicker">FIELD ACTIVITY</span><h3>Moola Plus visits</h3><p>Visits use upstream Moola Plus IDs and count under the rolling three-month coverage rule.</p></div><button className="btn btn-secondary btn-sm" onClick={() => navigate('/visits')}>All visits</button></div>
        <div className="metric-grid">
          <article className="metric-card"><span className="metric-index">V1</span><div className="metric-content"><span className="metric-label">Counted visits</span><strong className="metric-value">{Number(visitSummary?.total || 0).toLocaleString()}</strong><span className="metric-caption">Eligible for coverage metrics</span></div></article>
          <article className="metric-card"><span className="metric-index">V2</span><div className="metric-content"><span className="metric-label">Agents visited</span><strong className="metric-value">{Number(visitSummary?.uniqueAgentsVisited || 0).toLocaleString()}</strong><span className="metric-caption">Completed field visits</span></div></article>
          <article className="metric-card"><span className="metric-index">V3</span><div className="metric-content"><span className="metric-label">Follow-ups</span><strong className="metric-value">{Number(visitSummary?.followUps || 0).toLocaleString()}</strong><span className="metric-caption">Visible in history, excluded from totals</span></div></article>
          <article className="metric-card"><span className="metric-index">V4</span><div className="metric-content"><span className="metric-label">GPS verified</span><strong className="metric-value">{Number(visitSummary?.verified || 0).toLocaleString()}</strong><span className="metric-caption">Verified eligible visits</span></div></article>
        </div>
        {visitError && <ErrorState message={visitError} onRetry={() => load()} />}
        {!visitError && <section className="surface-card visit-table-card"><div className="table-scroll"><table className="data-table visit-table"><thead><tr><th>Visit reference</th><th>Agent</th><th>Coordinator</th><th>Status</th><th>Metric</th><th>Check-in</th></tr></thead><tbody>{recentVisits.map((visit) => <tr key={visit.id} onClick={() => navigate(`/visits/${visit.id}`)}><td>{visit.visitId}</td><td>{visit.externalAgentName || 'Moola Plus agent'}<small className="visit-subtext">{visit.externalAgentCode || '—'}</small></td><td>{[visit.tc?.firstName, visit.tc?.lastName].filter(Boolean).join(' ') || visit.tc?.username || '—'}</td><td><StatusBadge status={visit.visitStatus} /></td><td>{visit.countsForMetrics ? 'Counted' : 'Follow-up · excluded'}</td><td>{formatDate(visit.checkInTime)}</td></tr>)}{!recentVisits.length && <tr><td className="report-empty" colSpan="6">No Moola Plus visits recorded.</td></tr>}</tbody></table></div></section>}
      </section>
    </>}
  </div>;
}
