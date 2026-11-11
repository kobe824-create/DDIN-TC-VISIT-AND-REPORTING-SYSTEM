import React, { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw, UsersRound } from 'lucide-react';
import api from '../api';
import { ErrorState, LoadingState } from './index';

const formatNumber = (value) => Number(value || 0).toLocaleString();
const formatDate = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Kigali' }).format(new Date(value)) : '—';

export default function IremboActivity({ filters = {}, selectedStatus = '', onStatusSelect = () => {}, onSummary = () => {} }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/api/v1/reports/irembo/activity', { params: { ...filters, ...(forceRefresh ? { refresh: 'true' } : {}) } });
      setSummary(data);
      onSummary(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load Irembo transaction activity.');
    } finally {
      setLoading(false);
    }
  }, [filters, onSummary]);
  useEffect(() => { void load(); }, [load]);

  const byStatus = summary?.byStatus || {};
  const statuses = summary?.activityLevels || [
    { name: 'Active', range: '80+ transactions' },
    { name: 'Transacting', range: '30–79 transactions' },
    { name: 'Dormant', range: '1–29 transactions' },
    { name: 'Inactive', range: '0 transactions' },
  ];
  return <section className="irembo-activity-section" aria-label="Irembo transaction activity">
    <div className="irembo-activity-heading"><div><span className="section-kicker">IREMBO TRANSACTION FEED</span><h3>Agent activity</h3><p>Agent status follows the status returned by the Irembo API; transaction counts are shown separately.</p></div><button type="button" className="btn btn-secondary" onClick={() => load(true)} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />Refresh</button></div>
    {error && <ErrorState message={error} onRetry={() => load()} />}
    {loading && !summary ? <LoadingState type="cards" message="Loading Irembo transaction activity…" /> : summary && <>
      <div className="irembo-feed-summary">
        <article><UsersRound size={17} /><span><small>Agents in feed</small><strong>{formatNumber(summary.totalAgents)}</strong></span></article>
        <article><Activity size={17} /><span><small>Transactions reported</small><strong>{formatNumber(summary.totalTransactions)}</strong></span></article>
        <article><Activity size={17} /><span><small>Average per agent</small><strong>{Number(summary.averageTransactions || 0).toLocaleString()}</strong></span></article>
        <p>{summary.stale ? 'Showing the last successful feed refresh.' : 'Last synchronized'} {formatDate(summary.fetchedAt)} Rwanda time.</p>
      </div>
      <div className="irembo-activity-status-grid">{statuses.map(({ name, range }) => <button type="button" className={`irembo-activity-status${selectedStatus === name ? ' is-selected' : ''}`} key={name} aria-pressed={selectedStatus === name} onClick={() => onStatusSelect(selectedStatus === name ? '' : name)}><span>{name}</span><strong>{formatNumber(byStatus[name])}</strong><small>{range}</small></button>)}</div>
      <p className="moola-data-note">Status is calculated from the transaction count: Active 80+, Transacting 30–79, Dormant 1–29, and Inactive 0. If a date range is selected, the feed’s activity or registration date filters the agent records.</p>
    </>}
  </section>;
}
