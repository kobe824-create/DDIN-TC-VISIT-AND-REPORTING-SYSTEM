import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, UsersRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import MoolaAnalytics from '../components/MoolaAnalytics';
import PageHeader from '../components/PageHeader';
import { ErrorState, LoadingState, StatusBadge } from '../components';

const formatDate = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Kigali' }).format(new Date(value)) : '—';

export default function MoolaPlusReports() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState(null);
  const [visitSummary, setVisitSummary] = useState(null);
  const [recentVisits, setRecentVisits] = useState([]);
  const [visitError, setVisitError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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

  return <div className="page moola-reports-page">
    <PageHeader title="Moola Plus reports" subtitle="Agent activity and classifications from DDIN’s registry and deposit report." actions={<div className="page-header-actions"><button className="btn btn-secondary" onClick={() => navigate('/agents')}><UsersRound size={16} />Browse agents</button><button className="btn btn-primary" onClick={() => load(true)} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} />Refresh</button></div>} />
    {error && <ErrorState message={error} onRetry={load} />}
    {loading && !summary ? <LoadingState type="cards" message="Loading Moola Plus reports…" /> : summary && <>
      <div className="network-source-note"><strong>{summary.stale ? 'Showing the last successful sync' : 'Live DDIN registry data'}</strong><span>Last synced {formatDate(summary.fetchedAt)} Rwanda time.</span></div>
      <MoolaAnalytics summary={summary} />
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
