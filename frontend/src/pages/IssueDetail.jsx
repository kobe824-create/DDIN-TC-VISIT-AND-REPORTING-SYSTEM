import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, CircleHelp, Clock3, MapPin, MessageSquare, Send, UserRound } from 'lucide-react';
import { useAuth } from '../AuthContext';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, LoadingState } from '../components';
import { useToast } from '../components/Toast';
import { ISSUE_STATUS, categoryLabel, issueDate, personName, priorityLabel } from '../issues';
import '../issues.css';

const Status = ({ value }) => <span className={`issue-status issue-status-${(value || 'NEW').toLowerCase()}`}>{ISSUE_STATUS[value]?.label || value}</span>;
const statusNeedsNote = (status) => ['WAITING', 'ESCALATED', 'RESOLVED', 'REJECTED'].includes(status);
const displayName = (person, fallback = 'Former colleague') => person ? personName(person) : fallback;
const progressFor = (status) => {
  if (status === 'NEW') return 1;
  if (['IN_PROGRESS', 'WAITING', 'ESCALATED'].includes(status)) return 2;
  if (['RESOLVED', 'REJECTED'].includes(status)) return 3;
  return status === 'CLOSED' ? 4 : 0;
};

export default function IssueDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const isAdmin = user?.role?.toUpperCase() === 'ADMIN';
  const [issue, setIssue] = useState(null);
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [nextStatus, setNextStatus] = useState('');
  const [assigneeId, setAssigneeId] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [{ data: issueResponse }, adminsResponse] = await Promise.all([
        api.get(`/api/v1/issues/${id}`),
        isAdmin ? api.get('/api/v1/issues/admins') : Promise.resolve({ data: { data: [] } }),
      ]);
      setIssue(issueResponse.data);
      setAdmins(adminsResponse.data.data || []);
      setAssigneeId(issueResponse.data.assignedToId || '');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load this issue.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [id, isAdmin]);

  const statusChoices = useMemo(() => {
    if (!issue) return [];
    if (isAdmin) return Object.keys(ISSUE_STATUS).filter((status) => status !== issue.status);
    if (issue.status === 'RESOLVED') return ['CLOSED', 'NEW'];
    if (['REJECTED', 'CLOSED'].includes(issue.status)) return ['NEW'];
    return [];
  }, [issue, isAdmin]);

  const saveReply = async (event) => {
    event.preventDefault();
    if (!issue) return;
    const body = reply.trim();
    const changingAssignee = isAdmin && assigneeId && assigneeId !== issue.assignedToId;
    if (!body && !nextStatus && !changingAssignee) return;
    if (statusNeedsNote(nextStatus) && !body) {
      setError(`Add a comment explaining why this issue is ${ISSUE_STATUS[nextStatus]?.label.toLowerCase()}.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = { body };
      if (nextStatus) payload.status = nextStatus;
      if (changingAssignee) payload.assignedToId = assigneeId;
      await api.post(`/api/v1/issues/${id}/replies`, payload);
      setReply('');
      setNextStatus('');
      toast.addToast('Issue updated. The history now shows your reply.', 'success');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update this issue. Please retry.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="page"><LoadingState message="Loading issue details…" /></div>;
  if (error && !issue) return <div className="page"><PageHeader title="Issue" actions={<button className="btn btn-secondary" onClick={() => navigate('/issues')}><ArrowLeft size={15} />All issues</button>} /><ErrorState message={error} onRetry={load} /></div>;
  if (!issue) return null;

  const level = progressFor(issue.status);
  const location = [issue.village, issue.cell, issue.sector, issue.district, issue.province].filter(Boolean).join(', ');
  const reporter = displayName(issue.reporter, 'Former TC');
  const assigned = displayName(issue.assignedTo, 'No administrator assigned');
  const statusText = issue.status === 'RESOLVED'
    ? 'The administrator marked this issue resolved. The reporting TC can close it if the problem is solved, or reopen it if more help is needed.'
    : issue.status === 'CLOSED'
      ? 'The issue has been closed by the reporting TC.'
      : issue.status === 'REJECTED'
        ? 'The administrator rejected this report. Review the explanation in the history below.'
        : issue.status === 'WAITING'
          ? 'The administrator needs more information. Reply below to keep the issue moving.'
          : issue.status === 'ESCALATED'
            ? 'This issue has been escalated for further review.'
            : issue.status === 'IN_PROGRESS'
              ? 'The administrator is working on this issue.'
              : 'This issue has been reported and sent to an administrator.';

  return <div className="page issues-page">
    <PageHeader title={issue.code} subtitle={issue.title} breadcrumbs={[{ label: 'Issues', href: '/issues' }, { label: issue.code }]} actions={<button className="btn btn-secondary" onClick={() => navigate('/issues')}><ArrowLeft size={15} />All issues</button>} />

    <section className="surface-card issue-progress-card">
      <div className="issue-detail-statusline"><div><Status value={issue.status} /><span className={`issue-priority issue-priority-${issue.priority.toLowerCase()}`}>{priorityLabel(issue.priority)} priority</span></div><span className="issue-detail-updated"><Clock3 size={14} />Updated {issueDate(issue.updatedAt)}</span></div>
      <ol className="issue-progress-steps" aria-label="Issue progress">
        {['Reported', 'Assigned', 'Working on it', 'Resolved', 'Closed'].map((step, index) => {
          const number = index;
          const done = number < level;
          const active = number === level;
          const skipped = issue.status === 'REJECTED' && number === 3;
          return <li key={step} className={`${done ? 'is-done' : ''}${active ? ' is-current' : ''}${skipped ? ' is-stopped' : ''}`}><span className="issue-progress-dot">{done ? <Check size={13} /> : index + 1}</span><span>{skipped ? 'Rejected' : step}</span></li>;
        })}
      </ol>
      <p className="issue-progress-note">{statusText}</p>
    </section>

    <div className="issue-detail-grid">
      <div className="issue-detail-main">
        <section className="surface-card issue-description-card">
          <div className="issue-section-heading"><span className="issue-section-icon"><CircleHelp size={17} /></span><div><h2>Problem reported</h2><p>By {reporter} · {issueDate(issue.createdAt)}</p></div></div>
          <div className="issue-description-text">{issue.description}</div>
        </section>

        <section className="surface-card issue-history-card">
          <div className="issue-section-heading"><span className="issue-section-icon"><MessageSquare size={17} /></span><div><h2>Replies and progress</h2><p>{issue.comments?.length || 0} updates on this issue</p></div></div>
          {issue.comments?.length ? <ol className="issue-timeline">{issue.comments.map((comment) => <li key={comment.id} className="issue-timeline-item">
            <span className="issue-timeline-avatar">{(comment.author?.firstName?.[0] || comment.author?.username?.[0] || '?').toUpperCase()}</span>
            <div className="issue-timeline-content">
              <div className="issue-timeline-meta"><strong>{displayName(comment.author)}</strong><time>{issueDate(comment.createdAt)}</time></div>
              {comment.statusTo && <div className="issue-event-note">Status changed from {ISSUE_STATUS[comment.statusFrom]?.label || 'New'} to <Status value={comment.statusTo} /></div>}
              {comment.assignedTo && <div className="issue-event-note">Assigned to <strong>{personName(comment.assignedTo)}</strong></div>}
              {comment.body && <p className="issue-timeline-body">{comment.body}</p>}
              {!comment.body && !comment.statusTo && comment.assignedTo && <p className="issue-timeline-body issue-system-note">Issue assigned to an administrator.</p>}
            </div>
          </li>)}</ol> : <p className="issue-empty-history">No replies yet. Add a message below to keep the conversation here.</p>}
        </section>

        {issue.status !== 'CLOSED' || isAdmin || statusChoices.length > 0 ? <form className="surface-card issue-reply-card" onSubmit={saveReply}>
          <div className="issue-section-heading"><span className="issue-section-icon"><Send size={16} /></span><div><h2>{isAdmin ? 'Reply and update' : 'Reply to the administrator'}</h2><p>Your message and status changes are saved in the issue history.</p></div></div>
          {isAdmin && <div className="issue-admin-controls">
            <label className="issue-field"><span>Update status</span><select className="input" value={nextStatus} onChange={(event) => setNextStatus(event.target.value)}><option value="">Keep current status</option>{statusChoices.map((status) => <option value={status} key={status}>{ISSUE_STATUS[status].label}</option>)}</select></label>
            <label className="issue-field"><span>Assigned administrator</span><select className="input" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>{admins.map((admin) => <option value={admin.id} key={admin.id}>{personName(admin)}</option>)}</select></label>
          </div>}
          {!isAdmin && statusChoices.length > 0 && <div className="issue-reporter-actions"><span>{issue.status === 'RESOLVED' ? 'Is the problem solved?' : 'Need more help?'}</span>{statusChoices.map((status) => <button type="button" key={status} className={status === 'CLOSED' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} aria-pressed={nextStatus === status} onClick={() => setNextStatus((current) => current === status ? '' : status)}>{status === 'CLOSED' ? 'Close as solved' : 'Reopen issue'}</button>)}</div>}
          <label className="issue-field issue-reply-field"><span>Message{statusNeedsNote(nextStatus) ? ' · required for this status' : ''}</span><textarea className="input issue-description" value={reply} onChange={(event) => setReply(event.target.value)} maxLength={5000} rows={4} placeholder={statusNeedsNote(nextStatus) ? `Explain why the issue is ${ISSUE_STATUS[nextStatus]?.label.toLowerCase()}…` : 'Write a reply or add helpful details…'} /></label>
          {error && <p className="issue-inline-error" role="alert">{error}</p>}
          <div className="issue-reply-actions"><button type="submit" className="btn btn-primary" disabled={saving || (!reply.trim() && !nextStatus && (!isAdmin || assigneeId === issue.assignedToId))}>{saving ? 'Saving…' : 'Save update'}</button></div>
        </form> : <div className="issue-closed-note"><Check size={16} />This issue is closed. Reopen it if the problem returns.</div>}
      </div>

      <aside className="issue-detail-aside">
        <section className="surface-card issue-details-card"><h2>Issue details</h2><dl>
          <div><dt>Type</dt><dd>{categoryLabel(issue.category)}</dd></div>
          <div><dt>Priority</dt><dd>{priorityLabel(issue.priority)}</dd></div>
          <div><dt>Network</dt><dd>{issue.network === 'MOOLA_PLUS' ? 'Moola Plus' : issue.network === 'COMBINED' ? 'Other / both' : 'Irembo'}</dd></div>
          <div><dt>Reported by</dt><dd><UserRound size={14} />{reporter}</dd></div>
          <div><dt>Assigned to</dt><dd><UserRound size={14} />{assigned}</dd></div>
          <div><dt>Created</dt><dd>{issueDate(issue.createdAt)}</dd></div>
          {issue.resolvedAt && <div><dt>Resolved</dt><dd>{issueDate(issue.resolvedAt)}</dd></div>}
        </dl></section>
        <section className="surface-card issue-details-card"><h2>Agent details</h2>
          {issue.agentName || issue.agentCode || issue.agentPhone || location ? <dl>
            {issue.agentName && <div><dt>Name</dt><dd>{issue.agentName}</dd></div>}
            {issue.agentCode && <div><dt>Code</dt><dd>{issue.agentCode}</dd></div>}
            {issue.agentPhone && <div><dt>Phone</dt><dd><a href={`tel:${issue.agentPhone}`}>{issue.agentPhone}</a></dd></div>}
            {location && <div><dt><MapPin size={13} />Location</dt><dd>{location}</dd></div>}
          </dl> : <p className="issue-aside-empty">No agent details were added.</p>}
        </section>
      </aside>
    </div>
  </div>;
}
