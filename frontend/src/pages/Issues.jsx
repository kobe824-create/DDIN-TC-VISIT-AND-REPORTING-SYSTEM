import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, CircleCheck, LifeBuoy, Plus, Search } from 'lucide-react';
import { useAuth } from '../AuthContext';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components';
import { ISSUE_STATUS, categoryLabel, isIssueOpen, issueDate, personName } from '../issues';
import '../issues.css';

const Status = ({ value }) => <span className={`issue-status issue-status-${(value || 'NEW').toLowerCase()}`}>{ISSUE_STATUS[value]?.label || value}</span>;
const Priority = ({ value }) => <span className={`issue-priority issue-priority-${(value || 'NORMAL').toLowerCase()}`}>{value || 'NORMAL'}</span>;

export default function Issues() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role?.toUpperCase() === 'ADMIN';
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('OPEN');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/api/v1/issues');
      setIssues(data.data || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load issue reports.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const visibleIssues = useMemo(() => issues.filter((issue) => {
    const matchesFilter = filter === 'ALL' || (filter === 'OPEN' ? isIssueOpen(issue.status) : issue.status === filter);
    const haystack = [issue.code, issue.title, issue.agentName, issue.agentCode, issue.reporterName, issue.assignedToName].join(' ').toLowerCase();
    return matchesFilter && haystack.includes(search.trim().toLowerCase());
  }), [issues, filter, search]);
  const openCount = issues.filter((issue) => isIssueOpen(issue.status)).length;
  const resolvedCount = issues.filter((issue) => issue.status === 'RESOLVED').length;

  return <div className="page issues-page">
    <PageHeader
      title={isAdmin ? 'Issue inbox' : 'Issues'}
      subtitle={isAdmin ? 'Review field reports, respond to TCs, and keep every resolution in one place.' : 'Report an agent problem to an administrator and follow its progress here.'}
      actions={!isAdmin && <button className="btn btn-primary" onClick={() => navigate('/issues/new')}><Plus size={16} />Report an issue</button>}
    />

    <section className="issue-summary-grid" aria-label="Issue totals">
      <button type="button" className={`issue-summary-card${filter === 'OPEN' ? ' selected' : ''}`} onClick={() => setFilter('OPEN')}>
        <span className="issue-summary-icon issue-summary-icon-open"><AlertCircle size={18} /></span><span><strong>{openCount}</strong><small>Open issues</small></span>
      </button>
      <button type="button" className={`issue-summary-card${filter === 'RESOLVED' ? ' selected' : ''}`} onClick={() => setFilter('RESOLVED')}>
        <span className="issue-summary-icon issue-summary-icon-done"><CircleCheck size={18} /></span><span><strong>{resolvedCount}</strong><small>Resolved</small></span>
      </button>
      <button type="button" className={`issue-summary-card${filter === 'ALL' ? ' selected' : ''}`} onClick={() => setFilter('ALL')}>
        <span className="issue-summary-icon issue-summary-icon-total"><LifeBuoy size={18} /></span><span><strong>{issues.length}</strong><small>All reports</small></span>
      </button>
    </section>

    <section className="issue-list-tools surface-card">
      <label className="issue-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search code, title, agent or TC" aria-label="Search issues" /></label>
      <label className="issue-status-filter"><span>Show</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="OPEN">Open issues</option><option value="NEW">New</option><option value="IN_PROGRESS">Working on it</option><option value="WAITING">Waiting for information</option><option value="ESCALATED">Escalated</option><option value="RESOLVED">Resolved</option><option value="REJECTED">Rejected</option><option value="CLOSED">Closed</option><option value="ALL">All issues</option></select></label>
      <span className="issue-result-count">{visibleIssues.length} {visibleIssues.length === 1 ? 'issue' : 'issues'}</span>
    </section>

    {error && <ErrorState message={error} onRetry={load} />}
    {loading ? <LoadingState type="cards" message="Loading issue reports…" /> : !error && visibleIssues.length === 0 ? <section className="surface-card"><EmptyState icon={LifeBuoy} title={filter === 'OPEN' ? 'No open issues' : 'No issues found'} message={search ? 'Try another search or status filter.' : isAdmin ? 'New reports from TCs will appear in this inbox.' : 'When you report an agent problem, its status and replies will appear here.'} action={!isAdmin ? () => navigate('/issues/new') : undefined} actionLabel="Report an issue" /></section> : !error && <section className="surface-card issue-list-card">
      <div className="issue-list-heading"><div><span>Issue</span><span>Agent and territory</span><span>Status</span><span>Assigned to</span><span>Updated</span></div></div>
      <div className="issue-list-rows">
        {visibleIssues.map((issue) => <button className="issue-list-row" type="button" key={issue.id} onClick={() => navigate(`/issues/${issue.id}`)}>
          <span className="issue-row-main"><span className="issue-row-code">{issue.code}<Priority value={issue.priority} /></span><strong>{issue.title}</strong><small>{categoryLabel(issue.category)}{isAdmin ? ` · Reported by ${issue.reporterName || personName(issue.reporter)}` : ''}</small></span>
          <span className="issue-row-agent"><strong>{issue.agentName || 'Agent details not added'}</strong><small>{[issue.agentCode, issue.district, issue.sector].filter(Boolean).join(' · ') || issue.network?.replace('_', ' ')}</small></span>
          <span><Status value={issue.status} /></span>
          <span className="issue-row-assignee">{issue.assignedToName || personName(issue.assignedTo)}</span>
          <span className="issue-row-date">{issueDate(issue.updatedAt)}<ArrowRight size={15} /></span>
        </button>)}
      </div>
      {issues.length >= 200 && <p className="issue-list-footnote">Showing the 200 most recently updated issues.</p>}
    </section>}
  </div>;
}
