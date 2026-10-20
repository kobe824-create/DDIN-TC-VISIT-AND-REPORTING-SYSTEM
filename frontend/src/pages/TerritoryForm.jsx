import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Save } from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import FormField from '../components/FormField';
import { LoadingState } from '../components';

const types = [{ value: 'PROVINCE', label: 'Province' }, { value: 'DISTRICT', label: 'District' }, { value: 'SECTOR', label: 'Sector' }, { value: 'CELL', label: 'Cell' }, { value: 'VILLAGE', label: 'Village' }];

export default function TerritoryForm() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const parentIdParam = searchParams.get('parentId');
  const navigate = useNavigate();
  const isEdit = Boolean(id);
  const [form, setForm] = useState({ name: '', code: '', type: 'PROVINCE', parentId: '', isActive: true });
  const [territories, setTerritories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([api.get('/api/v1/territories'), isEdit ? api.get(`/api/v1/territories/${id}`) : Promise.resolve({ data: null })])
      .then(([allResponse, itemResponse]) => {
        if (!active) return;
        setTerritories(allResponse.data || []);
        if (itemResponse.data) setForm({ name: itemResponse.data.name, code: itemResponse.data.code, type: itemResponse.data.type, parentId: itemResponse.data.parentId || '', isActive: itemResponse.data.isActive });
        else if (parentIdParam) {
          const parent = allResponse.data.find((territory) => territory.id === parentIdParam);
          const childType = { PROVINCE: 'DISTRICT', DISTRICT: 'SECTOR', SECTOR: 'CELL', CELL: 'VILLAGE' }[parent?.type];
          setForm((current) => ({ ...current, parentId: parentIdParam, type: childType || 'PROVINCE' }));
        }
      }).catch((err) => { if (active) setError(err.response?.data?.error || 'Could not load territory data.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, isEdit, parentIdParam]);

  const parentType = { DISTRICT: 'PROVINCE', SECTOR: 'DISTRICT', CELL: 'SECTOR', VILLAGE: 'CELL' }[form.type] || null;
  const parents = useMemo(() => territories.filter((territory) => territory.type === parentType && territory.id !== id), [territories, parentType, id]);
  const changeType = (type) => setForm((current) => ({ ...current, type, parentId: type === 'PROVINCE' ? '' : current.parentId }));

  const submit = async (event) => {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const payload = { name: form.name.trim(), code: form.code.trim().toUpperCase(), type: form.type, parentId: parentType ? form.parentId : null, isActive: Boolean(form.isActive) };
      if (parentType && !payload.parentId) { setError(`Select a ${parentType.toLowerCase()} for this territory.`); setSaving(false); return; }
      if (isEdit) await api.put(`/api/v1/territories/${id}`, payload);
      else await api.post('/api/v1/territories', payload);
      navigate('/territories');
    } catch (err) { setError(err.response?.data?.error || 'Could not save this territory.'); }
    finally { setSaving(false); }
  };

  if (loading) return <LoadingState message="Loading territory form…" />;
  return <div className="territory-form-page page"><PageHeader title={isEdit ? 'Edit territory' : 'Add territory'} subtitle="Maintain the province, district and sector structure for assigned areas." breadcrumbs={[{ label: 'Territories', href: '/territories' }, { label: isEdit ? 'Edit territory' : 'New territory' }]} />{error && <div className="alert alert-error">{error}</div>}
    <form className="surface-card territory-form-card" onSubmit={submit}><div className="form-grid-two"><FormField.Input label="Territory name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required placeholder="Enter the official name" /><FormField.Input label="Area code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} required placeholder="e.g. DIST-GASABO" />
      <FormField.Select label="Administrative level" value={form.type} onChange={(event) => changeType(event.target.value)} disabled={isEdit} options={types} />
      {parentType && <FormField.Select label={`Parent ${parentType.toLowerCase()}`} value={form.parentId} onChange={(event) => setForm({ ...form, parentId: event.target.value })} required options={[{ value: '', label: `Select ${parentType.toLowerCase()}` }, ...parents.map((territory) => ({ value: territory.id, label: territory.name }))]} />}
      <FormField.Select label="Status" value={form.isActive ? 'true' : 'false'} onChange={(event) => setForm({ ...form, isActive: event.target.value === 'true' })} options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} />
      </div><div className="form-submit-row"><button type="button" className="btn btn-secondary" onClick={() => navigate('/territories')}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}><Save size={15} />{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create territory'}</button></div></form>
  </div>;
}
