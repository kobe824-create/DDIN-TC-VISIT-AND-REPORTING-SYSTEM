import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, MapPin, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '../AuthContext';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, ListPagination, LoadingState, StatusBadge } from '../components';
import { getVisitDrafts } from '../offline/store';

const nameOf = (person) => [person?.firstName, person?.lastName].filter(Boolean).join(' ') || person?.username || '—';
const dateOf = (value) => value ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';

export default function VisitList() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [visits, setVisits] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(searchParams.get('status') || '');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [exporting, setExporting] = useState(false);
  const [showingDeviceVisits, setShowingDeviceVisits] = useState(false);
  const canCreate = user?.role?.toUpperCase() === 'TC';
  const canExport = ['ADMIN', 'MANAGER'].includes(user?.role?.toUpperCase());

  const loadVisits = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: pageSize };
      if (search.trim()) params.search = search.trim();
      if (status) params.status = status;
      if (fromDate) params.fromDate = fromDate;
      if (toDate) params.toDate = toDate;
      const { data } = await api.get('/api/v1/visits', { params });
      setVisits(data.data || []);
      setTotal(data.meta?.total ?? data.data?.length ?? 0);
      setPages(data.meta?.pages ?? 0);
      setPage(data.meta?.page ?? page);
      setShowingDeviceVisits(false);
    } catch (err) {
      if (user?.role?.toUpperCase() === 'TC') {
        try {
          const drafts = (await getVisitDrafts(user.id)).filter((draft) => draft.completed);
          const localVisits = drafts.map((draft) => ({
            id: draft.clientVisitId,
            visitId: draft.publicVisitId || draft.clientVisitId,
            agent: draft.selectedAgent,
            tc: user,
            visitStatus: 'PENDING_SYNC',
            locationStatus: draft.gpsData?.locationStatus || 'VERIFIED',
            distanceMeters: draft.gpsData?.distance || 0,
            checkInTime: draft.checkInTime || draft.visitDate,
            offlineDraft: true,
          }));
          setVisits(localVisits);
          setTotal(localVisits.length);
          setPages(Math.ceil(localVisits.length / pageSize));
          setShowingDeviceVisits(true);
          setError(localVisits.length ? '' : (err.response?.data?.error || 'Could not load visit records.'));
        } catch { setError(err.response?.data?.error || 'Could not load visit records.'); }
      } else setError(err.response?.data?.error || 'Could not load visit records.');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, status, fromDate, toDate, user]);

  useEffect(() => {
    const timer = window.setTimeout(loadVisits, search.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [loadVisits, search]);
  useEffect(() => {
    const lastPage = Math.max(pages, 1);
    if (page > lastPage) setPage(lastPage);
  }, [page, pages]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { data } = await api.get('/api/v1/reports/export', { params: { fromDate, toDate }, responseType: 'blob' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(data);
      link.download = 'ddin-visits.csv';
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not export this report.');
    } finally {
      setExporting(false);
    }
  };

  const openVisit = (visit) => navigate(visit.offlineDraft ? '/visits/new' : `/visits/${visit.id}`);
  const visitRows = visits.map((visit) => <tr key={visit.id} onClick={() => openVisit(visit)} tabIndex="0" onKeyDown={(event) => event.key === 'Enter' && openVisit(visit)}>
    <td><div className="table-person"><span className="table-avatar"><MapPin size={14} /></span><span><strong>{visit.visitId}</strong><small>{visit.agent?.agentId || 'Agent'}</small></span></div></td>
    <td><strong className="visit-agent-name">{visit.agent?.name || 'Unknown agent'}</strong><small className="visit-subtext">{visit.agent?.businessName || '—'}</small></td>
    <td>{nameOf(visit.tc)}</td>
    <td>{visit.offlineDraft ? <StatusBadge status="pending" /> : <StatusBadge status={visit.visitStatus} />}</td>
    <td><span className={`location-result ${visit.locationStatus === 'VERIFIED' ? 'verified' : 'needs-review'}`}><span />{(visit.locationStatus || 'UNKNOWN').replaceAll('_', ' ')}</span><small className="visit-subtext">{Math.round(visit.distanceMeters || 0)} m from agent</small></td>
    <td>{dateOf(visit.checkInTime || visit.visitDate)}</td>
  </tr>);

  return <div className="visit-list-page page">
    <PageHeader title="Visits" subtitle="Review field check-ins, GPS verification and submitted reports." actions={<div className="flex gap-2">{canExport && <button className="btn btn-secondary" onClick={exportCsv} disabled={exporting}><Download size={16} />{exporting ? 'Preparing…' : 'Export CSV'}</button>}{canCreate && <button className="btn btn-primary" onClick={() => navigate('/visits/new')}><Plus size={16} />Start a visit</button>}</div>} />
    {showingDeviceVisits && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Showing completed visits saved on this device. They will appear in the shared visit history after synchronization.</div>}
    {error && <ErrorState message={error} onRetry={() => loadVisits()} />}
    <section className="visit-filters surface-card">
      <label className="visit-search"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search visit ID, agent or coordinator" /></label>
      <label className="visit-filter"><SlidersHorizontal size={15} /><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option><option value="STARTED">In progress</option><option value="COMPLETED">Completed</option><option value="FLAGGED">Flagged for review</option><option value="REJECTED">Rejected</option></select></label>
      <label className="visit-date-filter"><span>From</span><input type="date" value={fromDate} onChange={(event) => { setFromDate(event.target.value); setPage(1); }} /></label>
      <label className="visit-date-filter"><span>To</span><input type="date" value={toDate} onChange={(event) => { setToDate(event.target.value); setPage(1); }} /></label>
      <div className="visit-total"><strong>{total.toLocaleString()}</strong><span>records</span></div>
    </section>
    {loading ? <LoadingState message="Loading visit records…" /> : !error && <section className="surface-card visit-table-card">
      {visits.length ? <div className="table-scroll"><table className="data-table visit-table"><thead><tr><th>Visit reference</th><th>Agent</th><th>Coordinator</th><th>Visit status</th><th>GPS verification</th><th>Check-in</th></tr></thead><tbody>{visitRows}</tbody></table></div> : <div className="table-empty"><div className="empty-mark"><MapPin size={20} /></div><strong>No visits match these filters</strong><span>Try a different search or date range.</span></div>}
      <ListPagination page={page} pages={pages} total={total} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} />
      <div className="card-footnote"><MapPin size={14} /><span>GPS distance and verification status are calculated by the Visits service.</span></div>
    </section>}
  </div>;
}
