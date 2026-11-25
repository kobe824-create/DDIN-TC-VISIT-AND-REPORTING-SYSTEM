import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRightLeft, MapPin, UserRound } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, LoadingState, StatusBadge } from '../components';

const personDate = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const titleFor = (event) => event?.kind === 'TRANSFER' ? 'Agent transfer' : event?.kind === 'ADMIN_RELOCATION' ? 'Administrator relocation' : 'TC relocation request';

export default function MovementDetail() {
  const { eventKey } = useParams();
  const navigate = useNavigate();
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api.get(`/api/v1/reports/movements/${encodeURIComponent(eventKey)}`).then(({ data }) => {
      if (active) setEvent(data.event);
    }).catch((err) => {
      if (active) setError(err.response?.data?.error || 'Could not load this movement record.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [eventKey]);

  return <div className="page movement-detail-page">
    <PageHeader title={loading ? 'Movement record' : titleFor(event)} subtitle="Transfer and relocation history" breadcrumbs={[{ label: 'Reports', href: '/reports?tab=movements' }, { label: 'Transfers & relocations', href: '/reports?tab=movements' }, { label: 'Record details' }]} actions={<button type="button" className="btn btn-secondary" onClick={() => navigate('/reports?tab=movements')}><ArrowLeft size={16} />Back to report</button>} />
    {loading ? <LoadingState message="Loading movement record…" /> : error ? <ErrorState message={error} onRetry={() => window.location.reload()} /> : event && <>
      <section className="movement-detail-hero surface-card">
        <span className="report-metric-icon orange"><ArrowRightLeft size={18} /></span>
        <div><small>{event.kind === 'TRANSFER' ? 'TRANSFER' : 'RELOCATION'} · {event.agentNumber || 'Agent record'}</small><h2>{event.agentName}</h2><p>{event.phoneNumber || 'No phone number on record'}</p></div>
        <StatusBadge status={event.status === 'ACCEPTED_GPS_PENDING' ? 'Accepted · first visit GPS pending' : event.status} />
      </section>
      <section className="movement-detail-grid">
        <article className="surface-card movement-detail-card"><div className="movement-detail-heading"><MapPin size={17} /><h3>Territory movement</h3></div><dl><div><dt>From</dt><dd>{event.from || '—'}</dd></div><div><dt>To</dt><dd>{event.to || event.destinationPath || '—'}</dd></div>{event.destinationVenue && <div><dt>Venue</dt><dd>{event.destinationVenue}</dd></div>}</dl></article>
        <article className="surface-card movement-detail-card"><div className="movement-detail-heading"><UserRound size={17} /><h3>Request and review</h3></div><dl><div><dt>Requested by</dt><dd>{event.requestedBy || '—'}</dd></div><div><dt>Submitted</dt><dd>{personDate(event.requestedAt)}</dd></div><div><dt>Reviewed by</dt><dd>{event.reviewedBy || '—'}</dd></div><div><dt>Reviewed</dt><dd>{personDate(event.reviewedAt)}</dd></div><div><dt>Completed</dt><dd>{personDate(event.completedAt)}</dd></div></dl></article>
      </section>
      {(event.reason || event.reviewNote) && <section className="surface-card movement-detail-notes"><h3>Notes</h3>{event.reason && <div><small>Request note</small><p>{event.reason}</p></div>}{event.reviewNote && <div><small>Review note</small><p>{event.reviewNote}</p></div>}</section>}
      {event.agentId && <div className="movement-detail-actions"><button type="button" className="btn btn-secondary" onClick={() => navigate(`/agents/${encodeURIComponent(event.agentId)}`)}>Open agent profile</button></div>}
    </>}
  </div>;
}
