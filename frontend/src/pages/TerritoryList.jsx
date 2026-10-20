import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, MapPinned, Plus } from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, ListPagination, LoadingState, StatusBadge } from '../components';

const levelName = { PROVINCE: 'Province', DISTRICT: 'District', SECTOR: 'Sector', CELL: 'Cell', VILLAGE: 'Village' };

export default function TerritoryList() {
  const [territories, setTerritories] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/api/v1/territories');
      setTerritories(data || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load territories.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const childrenOf = (territory) => territories.filter((item) => item.parentId === territory.id);
  const roots = territories.filter((territory) => !territory.parentId);
  const rows = [];
  const appendVisibleRows = (territory, depth = 0) => {
    rows.push({ territory, depth });
    if (expanded[territory.id]) childrenOf(territory).forEach((child) => appendVisibleRows(child, depth + 1));
  };
  roots.forEach((territory) => appendVisibleRows(territory));
  const pages = Math.ceil(rows.length / pageSize);
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    const lastPage = Math.max(pages, 1);
    if (page > lastPage) setPage(lastPage);
  }, [page, pages]);

  const renderRow = ({ territory, depth }) => {
    const children = childrenOf(territory);
    const open = Boolean(expanded[territory.id]);
    const childType = { PROVINCE: 'District', DISTRICT: 'Sector', SECTOR: 'Cell', CELL: 'Village' }[territory.type] || null;
    return <div key={territory.id} className={`territory-row depth-${depth}`} style={{ paddingLeft: `${16 + depth * 23}px` }}>
      <button className="territory-expand" disabled={!children.length} onClick={() => setExpanded((current) => ({ ...current, [territory.id]: !current[territory.id] }))} aria-expanded={children.length ? open : undefined} aria-label={`${open ? 'Collapse' : 'Expand'} ${territory.name}`}>{children.length ? open ? <ChevronDown size={15} /> : <ChevronRight size={15} /> : <span />}</button>
      <span className={`territory-mark territory-${territory.type?.toLowerCase()}`}><MapPinned size={15} /></span>
      <div className="territory-info"><strong>{territory.name}</strong><span>{territory.code}</span></div>
      <span className="territory-type">{levelName[territory.type] || territory.type}</span>
      <StatusBadge status={territory.isActive ? 'ACTIVE' : 'INACTIVE'} showIcon={false} />
      <div className="territory-row-actions"><button className="btn btn-secondary btn-sm" onClick={() => navigate(`/territories/${territory.id}/edit`)}>Edit</button>{childType && <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/territories/new?parentId=${territory.id}`)}><Plus size={13} />{childType}</button>}</div>
    </div>;
  };

  return <div className="territory-page page">
    <PageHeader title="Territories" subtitle="Maintain the province, district, sector, cell and village structure used to scope field access." actions={<button className="btn btn-primary" onClick={() => navigate('/territories/new')}><Plus size={16} />Add province</button>} />
    {error && <ErrorState message={error} onRetry={() => load()} />}
    {loading ? <LoadingState message="Loading territory structure…" /> : !error && <section className="surface-card territory-tree"><div className="territory-tree-header"><span>Area</span><span>Level</span><span>Status</span><span>Actions</span></div>{rows.length ? pageRows.map(renderRow) : <div className="table-empty"><div className="empty-mark"><MapPinned size={20} /></div><strong>No territories have been registered</strong><span>Start by adding a province.</span><button className="btn btn-primary btn-sm" onClick={() => navigate('/territories/new')}>Add province</button></div>}
      <ListPagination page={page} pages={pages} total={rows.length} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} />
    </section>}
  </div>;
}
