import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Save, ShieldCheck, UserRoundPlus } from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import FormField from '../components/FormField';
import { LoadingState } from '../components';

const initial = { username: '', email: '', password: '', firstName: '', lastName: '', phoneNumber: '', role: 'TC', isActive: true, territoryIds: [] };

export default function UserForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEdit = Boolean(id);
  const [form, setForm] = useState(initial);
  const [territories, setTerritories] = useState([]);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get('/api/v1/territories'),
      isEdit ? api.get(`/api/v1/users/${id}`) : Promise.resolve({ data: null }),
    ]).then(([territoryResponse, userResponse]) => {
      if (!active) return;
      setTerritories(territoryResponse.data || []);
      if (userResponse.data) setForm({ ...initial, ...userResponse.data, password: '', territoryIds: [] });
    }).catch((err) => { if (active) setError(err.response?.data?.error || 'Could not load user data.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, isEdit]);

  const change = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const toggleTerritory = (territoryId) => setForm((current) => ({ ...current, territoryIds: current.territoryIds.includes(territoryId) ? current.territoryIds.filter((value) => value !== territoryId) : [...current.territoryIds, territoryId] }));

  const submit = async (event) => {
    event.preventDefault(); setError(''); setSaving(true);
    try {
      const payload = { username: form.username, email: form.email, role: form.role, firstName: form.firstName, lastName: form.lastName, phoneNumber: form.phoneNumber || null };
      if (isEdit) {
        await api.put(`/api/v1/users/${id}`, { ...payload, isActive: form.isActive });
      } else {
        if (form.password.length < 8) throw new Error('Use a password with at least 8 characters.');
        if (form.role === 'TC' && !form.territoryIds.length) throw new Error('Assign at least one district to this coordinator.');
        const { data } = await api.post('/api/v1/auth/register', { ...payload, password: form.password });
        if (form.role === 'TC') {
          for (const territoryId of form.territoryIds) await api.post('/api/v1/territories/assignments', { tcId: data.id, territoryId });
        }
      }
      navigate('/users');
    } catch (err) { setError(err.response?.data?.error || err.message || 'Could not save this user.'); }
    finally { setSaving(false); }
  };

  if (loading) return <LoadingState message="Loading user form…" />;
  const districts = territories.filter((territory) => territory.type === 'DISTRICT');

  return <div className="user-form-page page">
    <PageHeader title={isEdit ? 'Edit user' : 'Create user'} subtitle="Manage account identity, role and access." breadcrumbs={[{ label: 'Users & roles', href: '/users' }, { label: isEdit ? 'Edit user' : 'Create user' }]} />
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <form className="surface-card user-form-card" onSubmit={submit}>
      <div className="form-section-heading"><span className="detail-icon report-icon">{isEdit ? <ShieldCheck size={17} /> : <UserRoundPlus size={17} />}</span><div><h2>Account details</h2><p>Each account is scoped by its role and assigned areas.</p></div></div>
      <div className="form-grid-two">
        <FormField.Input label="First name" value={form.firstName} onChange={(event) => change('firstName', event.target.value)} required />
        <FormField.Input label="Last name" value={form.lastName} onChange={(event) => change('lastName', event.target.value)} required />
        <FormField.Input label="Username" value={form.username} onChange={(event) => change('username', event.target.value)} required disabled={isEdit} />
        <FormField.Input type="email" label="Email" value={form.email} onChange={(event) => change('email', event.target.value)} required />
        <FormField.Input type="tel" label="Phone number" value={form.phoneNumber || ''} onChange={(event) => change('phoneNumber', event.target.value)} />
        <FormField.Select label="Role" value={form.role} onChange={(event) => change('role', event.target.value)} options={['ADMIN', 'MANAGER', 'TC', 'CHAMPION', 'AGENT'].map((role) => ({ value: role, label: role === 'TC' ? 'Territory Coordinator' : role[0] + role.slice(1).toLowerCase() }))} />
        {!isEdit && <FormField.Input type="password" label="Temporary password" value={form.password} onChange={(event) => change('password', event.target.value)} required minLength={8} hint="At least 8 characters. Share this through your approved account setup process." />}
        {isEdit && <FormField.Select label="Account status" value={form.isActive ? 'true' : 'false'} onChange={(event) => change('isActive', event.target.value === 'true')} options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} />}
      </div>
      {!isEdit && form.role === 'TC' && <div className="user-assignment-panel"><div><strong>District access</strong><small>Select all districts assigned to this coordinator.</small></div><div className="territory-choice-grid">{districts.map((district) => <label key={district.id}><input type="checkbox" checked={form.territoryIds.includes(district.id)} onChange={() => toggleTerritory(district.id)} /><span>{district.name}</span><small>{district.code}</small></label>)}</div></div>}
      <div className="form-submit-row"><button type="button" className="btn btn-secondary" onClick={() => navigate('/users')}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}><Save size={15} />{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create account'}</button></div>
    </form>
  </div>;
}
