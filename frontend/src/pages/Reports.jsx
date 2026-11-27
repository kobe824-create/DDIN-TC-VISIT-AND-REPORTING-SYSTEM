import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, FileBarChart2, MapPin, Printer, RefreshCw, ShieldCheck, UsersRound, ArrowRightLeft } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../AuthContext';
import PageHeader from '../components/PageHeader';
import { ErrorState, ListPagination, LoadingState, StatusBadge } from '../components';
import MoolaPlusReports from './MoolaPlusReports';
import { MOOLA_PLUS_NETWORK, useNetwork } from '../NetworkContext';

const monthAgo = () => { const date = new Date(); date.setDate(date.getDate() - 30); return date.toISOString().slice(0, 10); };
const nameOf = (person) => [person?.firstName, person?.lastName].filter(Boolean).join(' ') || person?.username || '—';
const day = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value)) : '—';
const timeLabel = (value) => value
  ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Kigali' }).format(new Date(value))
  : '';

function IremboReports() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get('tab') === 'movements' ? 'movements' : 'visits');
  const [movementKind, setMovementKind] = useState('ALL');
  const [movementStatusFilter, setMovementStatusFilter] = useState('ALL');
  const [movementTerritoryId, setMovementTerritoryId] = useState('');
  const [movementTcId, setMovementTcId] = useState('');
  const [movementSearch, setMovementSearch] = useState('');
  const [movementQuery, setMovementQuery] = useState('');
  const [movementSortBy, setMovementSortBy] = useState('DATE_DESC');
  const [movementPage, setMovementPage] = useState(1);
  const [movementFilters, setMovementFilters] = useState({ territories: [], coordinators: [] });
  const [visits, setVisits] = useState([]);
  const [verificationVisits, setVerificationVisits] = useState([]);
  const [coverage, setCoverage] = useState([]);
  const [summary, setSummary] = useState({ total: 0, completed: 0, verified: 0, flagged: 0, photoVisits: 0 });
  const [visitPages, setVisitPages] = useState(0);
  const [visitTotal, setVisitTotal] = useState(0);
  const [verificationPages, setVerificationPages] = useState(0);
  const [verificationTotal, setVerificationTotal] = useState(0);
  const [fromDate, setFromDate] = useState(monthAgo());
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [visitsPage, setVisitsPage] = useState(1);
  const [verificationPage, setVerificationPage] = useState(1);
  const [coveragePage, setCoveragePage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [movementReport, setMovementReport] = useState(null);
  const [movementLoading, setMovementLoading] = useState(false);
  const [movementError, setMovementError] = useState('');
  const [movementUpdatedAt, setMovementUpdatedAt] = useState(null);
  const movementRequestIdRef = useRef(0);
  const movementRequestActiveRef = useRef(false);
  const isAdmin = user?.role === 'ADMIN';

  const loadReports = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const base = { fromDate, toDate, limit: pageSize, network: 'IREMBO' };
      const [visitResponse, verificationResponse, coverageResponse] = await Promise.all([
        api.get('/api/v1/reports/visits', { params: { ...base, page: visitsPage } }),
        api.get('/api/v1/reports/visits', { params: { ...base, page: verificationPage, unverifiedOnly: true } }),
        api.get('/api/v1/reports/coverage', { params: { fromDate, toDate } }),
      ]);
      setVisits(visitResponse.data.data || []);
      setVerificationVisits(verificationResponse.data.data || []);
      setSummary(visitResponse.data.summary || { total: 0, completed: 0, verified: 0, flagged: 0, photoVisits: 0 });
      setVisitTotal(visitResponse.data.meta?.total ?? 0);
      setVisitPages(visitResponse.data.meta?.pages ?? 0);
      setVisitsPage(visitResponse.data.meta?.page ?? visitsPage);
      setVerificationTotal(verificationResponse.data.meta?.total ?? 0);
      setVerificationPages(verificationResponse.data.meta?.pages ?? 0);
      setVerificationPage(verificationResponse.data.meta?.page ?? verificationPage);
      setCoverage(Array.isArray(coverageResponse.data) ? coverageResponse.data : []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load reports for the selected dates.');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, pageSize, visitsPage, verificationPage]);

  useEffect(() => { loadReports(); }, [loadReports]);
  const loadMovements = useCallback(async ({ silent = false } = {}) => {
    if (!isAdmin) return;
    if (silent && movementRequestActiveRef.current) return;
    const requestId = ++movementRequestIdRef.current;
    movementRequestActiveRef.current = true;
    if (!silent) { setMovementLoading(true); setMovementError(''); }
    try {
      const { data } = await api.get('/api/v1/reports/movements', { params: {
        _refresh: Date.now(),
        fromDate, toDate, territoryId: movementTerritoryId, tcId: movementTcId,
        kind: movementKind, status: movementStatusFilter, search: movementQuery,
        sortBy: movementSortBy, page: movementPage, limit: 25,
      } });
      if (requestId !== movementRequestIdRef.current) return;
      setMovementReport(data);
      setMovementFilters(data.filters || { territories: [], coordinators: [] });
      setMovementUpdatedAt(Date.now());
      setMovementError('');
      if (data.meta?.page && data.meta.page !== movementPage) setMovementPage(data.meta.page);
    } catch (err) {
      if (!silent && requestId === movementRequestIdRef.current) setMovementError(err.response?.data?.error || 'Could not load transfer and relocation activity.');
    } finally {
      if (requestId === movementRequestIdRef.current) {
        movementRequestActiveRef.current = false;
        if (!silent) setMovementLoading(false);
      }
    }
  }, [fromDate, toDate, isAdmin, movementTerritoryId, movementTcId, movementKind, movementStatusFilter, movementQuery, movementSortBy, movementPage]);
  useEffect(() => { if (tab === 'movements') loadMovements(); }, [tab, loadMovements]);
  useEffect(() => {
    if (!isAdmin || tab !== 'movements') return undefined;
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
  }, [isAdmin, tab, loadMovements]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setMovementQuery(movementSearch.trim());
      setMovementPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [movementSearch]);
  useEffect(() => {
    if (coveragePage > Math.max(Math.ceil(coverage.length / pageSize), 1)) setCoveragePage(Math.max(Math.ceil(coverage.length / pageSize), 1));
  }, [coverage.length, coveragePage, pageSize]);

  const verifiedRate = summary.completed ? Math.round(summary.verified / summary.completed * 100) : 0;
  const coveragePages = Math.ceil(coverage.length / pageSize);
  const coveragePageRows = coverage.slice((coveragePage - 1) * pageSize, coveragePage * pageSize);

  const exportReport = async () => {
    setExporting(true);
    try {
      const { data } = await api.get('/api/v1/reports/export', { params: { fromDate, toDate, network: 'IREMBO' }, responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const link = document.createElement('a'); link.href = url; link.download = 'ddin-field-visits.csv'; link.click(); URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not export the report.');
    } finally {
      setExporting(false);
    }
  };

  const exportPdf = () => window.print();
  const changeDate = (setter) => (event) => {
    setter(event.target.value);
    setVisitsPage(1);
    setVerificationPage(1);
    setCoveragePage(1);
    setMovementPage(1);
  };
  const tabs = [{ id: 'visits', label: 'Visit activity', icon: MapPin }, { id: 'coverage', label: 'Territory coverage', icon: UsersRound }, { id: 'verification', label: 'GPS verification', icon: ShieldCheck }, ...(isAdmin ? [{ id: 'movements', label: 'Transfers & relocations', icon: ArrowRightLeft }] : [])];
  const movementStats = movementReport?.summary || {};
  const movementEvents = movementReport?.events || [];
  const movementStatus = (event) => event.status === 'ACCEPTED_GPS_PENDING' ? 'Accepted · first visit GPS pending' : event.status === 'PENDING' ? (event.kind === 'TRANSFER' ? 'Awaiting TC review' : 'Awaiting admin review') : event.status.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());

  return <div className="reports-page page">
    <PageHeader title="Reports" subtitle={`Field activity · ${fromDate} to ${toDate}`} actions={<div className="page-header-actions"><button className="btn btn-secondary" onClick={() => navigate('/visits')}><ArrowLeft size={16} />Back to visits</button><button className="btn btn-secondary" onClick={exportPdf}><Printer size={15} />Export PDF</button><button className="btn btn-primary" onClick={exportReport} disabled={exporting}><Download size={15} />{exporting ? 'Preparing…' : 'Export CSV'}</button></div>} />
    <section className="report-filter-panel surface-card"><div className="report-filter-intro"><span className="report-filter-icon"><FileBarChart2 size={17} /></span><div><strong>Reporting period</strong><small>Choose dates for your field activity summary.</small></div></div><label><span>From</span><input type="date" value={fromDate} onChange={changeDate(setFromDate)} /></label><label><span>To</span><input type="date" value={toDate} onChange={changeDate(setToDate)} /></label></section>
    {error && <ErrorState message={error} onRetry={() => loadReports()} />}
    {loading ? <LoadingState message="Building reports…" /> : !error && <>
      <section className="report-metrics"><div><span className="report-metric-icon orange"><MapPin size={16} /></span><span><small>Visits counted</small><strong>{summary.total.toLocaleString()}</strong></span></div><div><span className="report-metric-icon green"><ShieldCheck size={16} /></span><span><small>Verified rate</small><strong>{verifiedRate}%</strong></span></div><div><span className="report-metric-icon amber"><FileBarChart2 size={16} /></span><span><small>Needs review</small><strong>{summary.flagged.toLocaleString()}</strong></span></div><div><span className="report-metric-icon blue"><UsersRound size={16} /></span><span><small>Photo evidence</small><strong>{summary.photoVisits.toLocaleString()} / {summary.total.toLocaleString()}</strong></span></div></section>
      <section className="surface-card report-results-card"><nav className="report-tabs" role="tablist">{tabs.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={15} />{label}</button>)}</nav>
        {tab === 'visits' && <><div className="table-scroll"><table className="data-table report-table"><thead><tr><th>Visit</th><th>Agent</th><th>Coordinator</th><th>Status</th><th>GPS result</th><th>Date</th></tr></thead><tbody>{visits.map((visit) => <tr key={visit.id}><td>{visit.visitId}</td><td>{visit.agent?.name || '—'}</td><td>{nameOf(visit.tc)}</td><td><StatusBadge status={visit.visitStatus} />{visit.countsForMetrics === false && <small className="metric-exclusion-note">Follow-up · excluded from metrics</small>}</td><td><StatusBadge status={visit.locationStatus} /></td><td>{day(visit.visitDate || visit.checkInTime)}</td></tr>)}{!visits.length && <tr><td className="report-empty" colSpan="6">No visits recorded during this period.</td></tr>}</tbody></table></div><ListPagination page={visitsPage} pages={visitPages} total={visitTotal} pageSize={pageSize} onPageChange={setVisitsPage} onPageSizeChange={(value) => { setPageSize(value); setVisitsPage(1); setVerificationPage(1); setCoveragePage(1); }} /></>}
        {tab === 'coverage' && <><div className="table-scroll"><table className="data-table report-table"><thead><tr><th>Territory</th><th>Active agents</th><th>Agents visited</th><th>Coverage</th></tr></thead><tbody>{coveragePageRows.map((row) => <tr key={row.territoryId}><td><strong>{row.territoryName}</strong></td><td>{row.totalAgents}</td><td>{row.uniqueAgentsVisited}</td><td><span className="coverage-cell">{row.coveragePercentage}</span></td></tr>)}{!coverage.length && <tr><td className="report-empty" colSpan="4">No territory coverage data for this period.</td></tr>}</tbody></table></div><ListPagination page={coveragePage} pages={coveragePages} total={coverage.length} pageSize={pageSize} onPageChange={setCoveragePage} onPageSizeChange={(value) => { setPageSize(value); setCoveragePage(1); setVisitsPage(1); setVerificationPage(1); }} /></>}
        {tab === 'verification' && <><div className="table-scroll"><table className="data-table report-table"><thead><tr><th>Visit</th><th>Agent</th><th>Coordinator</th><th>Distance</th><th>GPS accuracy</th><th>Result</th></tr></thead><tbody>{verificationVisits.map((visit) => <tr key={visit.id}><td>{visit.visitId}</td><td>{visit.agent?.name || '—'}</td><td>{nameOf(visit.tc)}</td><td>{Math.round(visit.distanceMeters || 0)} m</td><td>±{Math.round(visit.gpsAccuracyMeters || 0)} m</td><td><StatusBadge status={visit.locationStatus} /></td></tr>)}{!verificationTotal && <tr><td className="report-empty" colSpan="6">All visits in this period passed GPS verification.</td></tr>}</tbody></table></div><ListPagination page={verificationPage} pages={verificationPages} total={verificationTotal} pageSize={pageSize} onPageChange={setVerificationPage} onPageSizeChange={(value) => { setPageSize(value); setVerificationPage(1); setVisitsPage(1); setCoveragePage(1); }} /></>}
        {tab === 'movements' && <>
          {movementError && <ErrorState message={movementError} onRetry={loadMovements} />}
          {movementLoading ? <LoadingState message="Loading transfer and relocation activity…" /> : !movementError && <>
            <section className="report-metrics movement-metrics">
              <div><span className="report-metric-icon orange"><ArrowRightLeft size={16} /></span><span><small>Transfers</small><strong>{(movementStats.transferRequests || 0).toLocaleString()}</strong><em>{movementStats.transfersCompleted || 0} completed · {movementStats.transfersAwaitingReview || 0} awaiting review</em></span></div>
              <div><span className="report-metric-icon amber"><MapPin size={16} /></span><span><small>Relocations + venue assignments</small><strong>{(movementStats.relocationsIncludingVenueAssignments ?? movementStats.relocationRequests ?? 0).toLocaleString()}</strong><em>{(movementStats.relocationRequests || 0).toLocaleString()} requests · {(movementStats.venueAssignments || 0).toLocaleString()} venue updates</em></span></div>
              <div><span className="report-metric-icon blue"><UsersRound size={16} /></span><span><small>Admin relocations</small><strong>{(movementStats.adminRelocations || 0).toLocaleString()}</strong><em>Completed moves recorded by administrators</em></span></div>
              <div><span className="report-metric-icon green"><ShieldCheck size={16} /></span><span><small>Combined movements</small><strong>{(movementStats.totalMovements || 0).toLocaleString()}</strong><em>{(movementStats.totalRelocations || 0).toLocaleString()} relocations and transfers</em></span></div>
            </section>
            <div className="movement-rate-strip"><span>{movementStats.transferAcceptanceRate || 0}% of transfers accepted</span><span>{movementStats.relocationsRejected || 0} relocation requests declined</span><span>{movementStats.relocationApprovalRate || 0}% of reviewed TC relocations approved</span></div>
            <div className="movement-list-toolbar">
              <div className="movement-kind-filters" role="tablist" aria-label="Filter movement report">
                {[['ALL', 'All movements'], ['TRANSFER', 'Transfers'], ['RELOCATION', 'Relocations']].map(([value, label]) => <button type="button" key={value} role="tab" aria-selected={movementKind === value} className={movementKind === value ? 'active' : ''} onClick={() => { setMovementKind(value); setMovementPage(1); }}>{label}</button>)}
              </div>
              <div className="movement-live-actions"><small aria-live="polite" title="Automatically refreshes every 10 seconds while this tab is visible.">{movementUpdatedAt ? `Live · updated ${timeLabel(movementUpdatedAt)}` : 'Updating…'}</small><button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadMovements({ silent: true })} disabled={movementLoading}><RefreshCw size={14} />Refresh</button><small>Open any row to see the full movement record.</small></div>
            </div>
            <div className="movement-filter-grid">
              <label>District / territory<select className="input" value={movementTerritoryId} onChange={(event) => { setMovementTerritoryId(event.target.value); setMovementPage(1); }}><option value="">All territories</option>{movementFilters.territories.map((territory) => <option key={territory.id} value={territory.id}>{territory.name}</option>)}</select></label>
              <label>TC<select className="input" value={movementTcId} onChange={(event) => { setMovementTcId(event.target.value); setMovementPage(1); }}><option value="">All coordinators</option>{movementFilters.coordinators.map((tc) => <option key={tc.id} value={tc.id}>{tc.name}{tc.username ? ' · ' + tc.username : ''}</option>)}</select></label>
              <label>Status<select className="input" value={movementStatusFilter} onChange={(event) => { setMovementStatusFilter(event.target.value); setMovementPage(1); }}><option value="ALL">All statuses</option><option value="PENDING">Pending review</option><option value="ACCEPTED_GPS_PENDING">Accepted · GPS pending</option><option value="COMPLETED">Completed</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="ON_HOLD">On hold</option><option value="CANCELLED">Cancelled</option></select></label>
              <label>Sort by<select className="input" value={movementSortBy} onChange={(event) => { setMovementSortBy(event.target.value); setMovementPage(1); }}><option value="DATE_DESC">Newest first</option><option value="DATE_ASC">Oldest first</option><option value="TERRITORY">Territory</option><option value="TC">TC name</option><option value="AGENT">Agent name</option></select></label>
              <label className="movement-search-field">Search<input className="input" type="search" value={movementSearch} onChange={(event) => setMovementSearch(event.target.value)} placeholder="Agent, phone, TC, territory, or note" /></label>
              <button type="button" className="btn btn-secondary movement-clear-filters" onClick={() => { setMovementKind('ALL'); setMovementStatusFilter('ALL'); setMovementTerritoryId(''); setMovementTcId(''); setMovementSearch(''); setMovementQuery(''); setMovementSortBy('DATE_DESC'); setMovementPage(1); }}>Clear filters</button>
            </div>
            <div className="table-scroll"><table className="data-table report-table movement-table"><thead><tr><th>Type</th><th>Agent & contact</th><th>From</th><th>To</th><th>Requested by</th><th>Reviewed by</th><th>Status</th><th>Date</th></tr></thead><tbody>
              {movementEvents.map((event) => <tr key={event.id} className="movement-report-row" tabIndex={0} role="link" aria-label={`Open ${event.changeType === 'VENUE_ASSIGNMENT' ? 'venue assignment' : event.kind === 'TRANSFER' ? 'transfer' : 'relocation'} record for ${event.agentName}`} onClick={() => navigate(`/reports/movements/${encodeURIComponent(event.id)}`)} onKeyDown={(keyboardEvent) => { if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') { keyboardEvent.preventDefault(); navigate(`/reports/movements/${encodeURIComponent(event.id)}`); } }}><td>{event.changeType === 'VENUE_ASSIGNMENT' ? 'Venue assignment' : event.kind === 'TRANSFER' ? 'Transfer' : event.kind === 'RELOCATION' ? 'TC relocation' : 'Admin relocation'}</td><td><strong>{event.agentName}</strong><small className="visit-subtext">{event.agentNumber}{event.phoneNumber ? ` · ${event.phoneNumber}` : ''}</small></td><td>{event.from}</td><td>{event.to}</td><td>{event.requestedBy}</td><td>{event.reviewedBy}</td><td><span className={`movement-status ${event.status.toLowerCase().replaceAll('_', '-')}`}>{movementStatus(event)}</span></td><td>{day(event.requestedAt)}</td></tr>)}
              {!movementEvents.length && <tr><td className="report-empty" colSpan="8">{movementReport?.meta?.total ? 'No movements match these filters.' : 'No transfers or relocations match this period and filter set.'}</td></tr>}
            </tbody></table></div>
            <ListPagination page={movementReport?.meta?.page || movementPage} pages={movementReport?.meta?.pages || 0} total={movementReport?.meta?.total || 0} pageSize={25} showPageSize={false} onPageChange={setMovementPage} />
          </>}
        </>}
        <div className="card-footnote"><ShieldCheck size={14} /><span>Coverage = unique active agents visited ÷ active agents in each territory. Repeat visits remain listed but are excluded from report totals and coverage.</span></div>
      </section>
    </>}
  </div>;
}

export default function Reports() {
  const { network } = useNetwork();
  return network === MOOLA_PLUS_NETWORK ? <MoolaPlusReports /> : <IremboReports />;
}
