import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, Camera, Clock3, FileText, MapPin, Navigation, Printer, ShieldAlert } from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, LoadingState, StatusBadge } from '../components';

const reportFields = [
  ['operatingStatus', 'Operating status'], ['servicesOffered', 'Services offered'], ['productsOffered', 'Products offered'],
  ['generalObservations', 'General observations'], ['liquidityObservations', 'Liquidity observations'],
  ['customerQualityObservations', 'Customer experience'], ['challengesFaced', 'Challenges faced'],
  ['supportNeeds', 'Support needs'], ['trainingNeeds', 'Training needs'], ['followUpActions', 'Follow-up actions'],
  ['additionalRemarks', 'Additional remarks'],
];
const fullName = (person) => [person?.firstName, person?.lastName].filter(Boolean).join(' ') || person?.username || '—';
const dateTime = (value) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const coordinate = (value) => Number.isFinite(Number(value)) ? Number(value).toFixed(6) : '—';

export default function VisitDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [visit, setVisit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [photoOpen, setPhotoOpen] = useState(false);

  const loadVisit = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/api/v1/visits/${id}`);
      setVisit(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load this visit record.');
    } finally { setLoading(false); }
  };

  useEffect(() => { loadVisit(); }, [id]);
  if (loading) return <LoadingState type="detail" />;
  if (error || !visit) return <ErrorState message={error || 'Visit not found.'} onRetry={loadVisit} />;

  const evidence = visit.photos?.[0];
  const verified = visit.locationStatus === 'VERIFIED';
  const timeline = [
    { label: 'Checked in', date: visit.checkInTime, icon: MapPin },
    { label: 'Evidence captured', date: evidence?.photoCapturedAt, icon: Camera },
    { label: 'Checked out', date: visit.checkOutTime, icon: Clock3 },
  ].filter((item) => item.date);

  return <div className="visit-detail-page page">
    <PageHeader title={visit.visitId || 'Visit record'} subtitle="Verified field visit record and submitted evidence." breadcrumbs={[{ label: 'Visits', href: '/visits' }, { label: visit.visitId || 'Visit' }]} actions={<div className="page-header-actions"><button className="btn btn-secondary" onClick={() => navigate('/visits')}><ArrowLeft size={16} />Back to visits</button><button className="btn btn-primary" onClick={() => window.print()}><Printer size={15} />Export PDF</button><StatusBadge status={visit.visitStatus} /></div>} />
    <section className="visit-summary surface-card">
      <div className="visit-summary-main"><span className="summary-agent-avatar">{(visit.agent?.name || 'A').slice(0, 1).toUpperCase()}</span><div><span className="section-kicker">AGENT VISIT</span><h2>{visit.agent?.name || 'Unknown agent'}</h2><p>{visit.agent?.businessName || 'Independent agent'} <span>·</span> {visit.agent?.agentId || 'Agent ID unavailable'}</p></div></div>
      <div className="summary-meta"><span>Territory</span><strong>{visit.territory?.name || visit.agent?.territory?.name || '—'}</strong></div>
      <div className="summary-meta"><span>Coordinator</span><strong>{fullName(visit.tc)}</strong></div>
      <div className="summary-meta"><span>Visit date</span><strong>{dateTime(visit.visitDate || visit.checkInTime)}</strong></div>
    </section>

    <section className="visit-detail-grid">
      <div className="visit-detail-main">
        <article className="surface-card detail-panel">
          <div className="detail-panel-heading"><span className="detail-icon gps-icon"><Navigation size={17} /></span><div><h3>Location verification</h3><p>GPS reading captured at check-in</p></div><span className={`verification-status ${verified ? 'good' : 'review'}`}>{verified ? <BadgeCheck size={14} /> : <ShieldAlert size={14} />}{verified ? 'Verified' : 'Review required'}</span></div>
          <div className="gps-metrics"><div><span>Distance to agent</span><strong>{Math.round(visit.distanceMeters || 0)} <small>m</small></strong></div><div><span>GPS accuracy</span><strong>±{Math.round(visit.gpsAccuracyMeters || 0)} <small>m</small></strong></div><div><span>Location status</span><StatusBadge status={visit.locationStatus} /></div></div>
          <div className="coordinate-grid"><div><span>TC coordinates</span><code>{coordinate(visit.tcLatitude)}, {coordinate(visit.tcLongitude)}</code></div><div><span>Registered agent coordinates</span><code>{coordinate(visit.agentLatitude)}, {coordinate(visit.agentLongitude)}</code></div></div>
        </article>

        <article className="surface-card detail-panel report-panel">
          <div className="detail-panel-heading"><span className="detail-icon report-icon"><FileText size={17} /></span><div><h3>Visit report</h3><p>Observations and follow-up recorded by the coordinator</p></div></div>
          {visit.report ? <div className="report-grid">{reportFields.map(([key, label]) => <div className="report-answer" key={key}><span>{label}</span><p>{visit.report[key] || <em>Not provided</em>}</p></div>)}{Object.entries(visit.report.checklistData || {}).map(([key, result]) => <div className="report-answer" key={key}><span>{result?.question || `Checklist ${key}`}</span><p>{result?.answer ?? result ?? <em>Not provided</em>}</p></div>)}</div> : <div className="detail-empty">No report was attached to this visit.</div>}
        </article>
      </div>

      <aside className="visit-detail-aside">
        <article className="surface-card evidence-panel">
          <div className="detail-panel-heading"><span className="detail-icon photo-icon"><Camera size={17} /></span><div><h3>Photo evidence</h3><p>Captured during the visit</p></div></div>
          {evidence ? <button className="evidence-image-button" onClick={() => setPhotoOpen(true)}><img src={evidence.photoUrl} alt="Visit evidence" /><span>{dateTime(evidence.photoCapturedAt)}</span></button> : <div className="detail-empty">No photo evidence attached.</div>}
        </article>
        <article className="surface-card timeline-panel">
          <div className="detail-panel-heading"><span className="detail-icon timeline-icon"><Clock3 size={17} /></span><div><h3>Visit timeline</h3><p>Recorded timestamps</p></div></div>
          <div className="visit-timeline">{timeline.map(({ label, date, icon: Icon }, index) => <div className="timeline-item" key={label}><span className={`timeline-marker ${index === timeline.length - 1 ? 'is-last' : ''}`}><Icon size={13} /></span><div><strong>{label}</strong><span>{dateTime(date)}</span></div></div>)}</div>
          {visit.checkInTime && visit.checkOutTime && <div className="visit-duration"><span>Time on site</span><strong>{Math.max(0, Math.round((new Date(visit.checkOutTime) - new Date(visit.checkInTime)) / 60000))} min</strong></div>}
        </article>
      </aside>
    </section>
    {photoOpen && evidence && <button className="photo-lightbox" aria-label="Close photo preview" onClick={() => setPhotoOpen(false)}><img src={evidence.photoUrl} alt="Visit evidence enlarged" /></button>}
  </div>;
}
