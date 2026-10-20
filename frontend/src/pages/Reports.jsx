import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Download, FileBarChart2, MapPin, Printer, ShieldCheck, UsersRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, ListPagination, LoadingState, StatusBadge } from '../components';

const monthAgo = () => { const date = new Date(); date.setDate(date.getDate() - 30); return date.toISOString().slice(0, 10); };
const nameOf = (person) => [person?.firstName, person?.lastName].filter(Boolean).join(' ') || person?.username || '—';
const day = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value)) : '—';

export default function Reports() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('visits');
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

  const loadReports = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const base = { fromDate, toDate, limit: pageSize };
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
  useEffect(() => {
    if (coveragePage > Math.max(Math.ceil(coverage.length / pageSize), 1)) setCoveragePage(Math.max(Math.ceil(coverage.length / pageSize), 1));
  }, [coverage.length, coveragePage, pageSize]);

  const verifiedRate = summary.completed ? Math.round(summary.verified / summary.completed * 100) : 0;
  const coveragePages = Math.ceil(coverage.length / pageSize);
  const coveragePageRows = coverage.slice((coveragePage - 1) * pageSize, coveragePage * pageSize);

  const exportReport = async () => {
    setExporting(true);
    try {
      const { data } = await api.get('/api/v1/reports/export', { params: { fromDate, toDate }, responseType: 'blob' });
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
  };
  const tabs = [{ id: 'visits', label: 'Visit activity', icon: MapPin }, { id: 'coverage', label: 'Territory coverage', icon: UsersRound }, { id: 'verification', label: 'GPS verification', icon: ShieldCheck }];

  return <div className="reports-page page">
    <PageHeader title="Reports" subtitle={`Field activity · ${fromDate} to ${toDate}`} actions={<div className="page-header-actions"><button className="btn btn-secondary" onClick={() => navigate('/visits')}><ArrowLeft size={16} />Back to visits</button><button className="btn btn-secondary" onClick={exportPdf}><Printer size={15} />Export PDF</button><button className="btn btn-primary" onClick={exportReport} disabled={exporting}><Download size={15} />{exporting ? 'Preparing…' : 'Export CSV'}</button></div>} />
    <section className="report-filter-panel surface-card"><div className="report-filter-intro"><span className="report-filter-icon"><FileBarChart2 size={17} /></span><div><strong>Reporting period</strong><small>Choose dates for your field activity summary.</small></div></div><label><span>From</span><input type="date" value={fromDate} onChange={changeDate(setFromDate)} /></label><label><span>To</span><input type="date" value={toDate} onChange={changeDate(setToDate)} /></label></section>
    {error && <ErrorState message={error} onRetry={() => loadReports()} />}
    {loading ? <LoadingState message="Building reports…" /> : !error && <>
      <section className="report-metrics"><div><span className="report-metric-icon orange"><MapPin size={16} /></span><span><small>Visits recorded</small><strong>{summary.total.toLocaleString()}</strong></span></div><div><span className="report-metric-icon green"><ShieldCheck size={16} /></span><span><small>Verified rate</small><strong>{verifiedRate}%</strong></span></div><div><span className="report-metric-icon amber"><FileBarChart2 size={16} /></span><span><small>Needs review</small><strong>{summary.flagged.toLocaleString()}</strong></span></div><div><span className="report-metric-icon blue"><UsersRound size={16} /></span><span><small>Photo evidence</small><strong>{summary.photoVisits.toLocaleString()} / {summary.total.toLocaleString()}</strong></span></div></section>
      <section className="surface-card report-results-card"><nav className="report-tabs" role="tablist">{tabs.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={15} />{label}</button>)}</nav>
        {tab === 'visits' && <><div className="table-scroll"><table className="data-table report-table"><thead><tr><th>Visit</th><th>Agent</th><th>Coordinator</th><th>Status</th><th>GPS result</th><th>Date</th></tr></thead><tbody>{visits.map((visit) => <tr key={visit.id}><td>{visit.visitId}</td><td>{visit.agent?.name || '—'}</td><td>{nameOf(visit.tc)}</td><td><StatusBadge status={visit.visitStatus} /></td><td><StatusBadge status={visit.locationStatus} /></td><td>{day(visit.visitDate || visit.checkInTime)}</td></tr>)}{!visits.length && <tr><td className="report-empty" colSpan="6">No visits recorded during this period.</td></tr>}</tbody></table></div><ListPagination page={visitsPage} pages={visitPages} total={visitTotal} pageSize={pageSize} onPageChange={setVisitsPage} onPageSizeChange={(value) => { setPageSize(value); setVisitsPage(1); setVerificationPage(1); setCoveragePage(1); }} /></>}
        {tab === 'coverage' && <><div className="table-scroll"><table className="data-table report-table"><thead><tr><th>Territory</th><th>Active agents</th><th>Agents visited</th><th>Coverage</th></tr></thead><tbody>{coveragePageRows.map((row) => <tr key={row.territoryId}><td><strong>{row.territoryName}</strong></td><td>{row.totalAgents}</td><td>{row.uniqueAgentsVisited}</td><td><span className="coverage-cell">{row.coveragePercentage}</span></td></tr>)}{!coverage.length && <tr><td className="report-empty" colSpan="4">No territory coverage data for this period.</td></tr>}</tbody></table></div><ListPagination page={coveragePage} pages={coveragePages} total={coverage.length} pageSize={pageSize} onPageChange={setCoveragePage} onPageSizeChange={(value) => { setPageSize(value); setCoveragePage(1); setVisitsPage(1); setVerificationPage(1); }} /></>}
        {tab === 'verification' && <><div className="table-scroll"><table className="data-table report-table"><thead><tr><th>Visit</th><th>Agent</th><th>Coordinator</th><th>Distance</th><th>GPS accuracy</th><th>Result</th></tr></thead><tbody>{verificationVisits.map((visit) => <tr key={visit.id}><td>{visit.visitId}</td><td>{visit.agent?.name || '—'}</td><td>{nameOf(visit.tc)}</td><td>{Math.round(visit.distanceMeters || 0)} m</td><td>±{Math.round(visit.gpsAccuracyMeters || 0)} m</td><td><StatusBadge status={visit.locationStatus} /></td></tr>)}{!verificationTotal && <tr><td className="report-empty" colSpan="6">All visits in this period passed GPS verification.</td></tr>}</tbody></table></div><ListPagination page={verificationPage} pages={verificationPages} total={verificationTotal} pageSize={pageSize} onPageChange={setVerificationPage} onPageSizeChange={(value) => { setPageSize(value); setVerificationPage(1); setVisitsPage(1); setCoveragePage(1); }} /></>}
        <div className="card-footnote"><ShieldCheck size={14} /><span>Coverage = unique active agents visited ÷ active agents in each territory.</span></div>
      </section>
    </>}
  </div>;
}
