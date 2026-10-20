import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LocateFixed, MapPin, Save, UsersRound } from 'lucide-react';
import { useAuth } from '../AuthContext';
import api from '../api';
import PageHeader from '../components/PageHeader';
import FormField from '../components/FormField';
import { LoadingState } from '../components';

const emptyForm = { agentId: '', name: '', phoneNumber: '', businessName: '', address: '', nationalId: '', nextOfKinName: '', nextOfKinPhone: '', territoryId: '', sectorId: '', cellId: '', villageId: '', championId: '', status: 'ACTIVE', registeredLatitude: '', registeredLongitude: '', gpsAccuracy: '' };

export default function AgentForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isEdit = Boolean(id);
  const [form, setForm] = useState(emptyForm);
  const [territories, setTerritories] = useState([]);
  const [champions, setChampions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [locationReason, setLocationReason] = useState('');
  const [gpsRecaptured, setGpsRecaptured] = useState(false);
  const districts = useMemo(() => territories.filter((territory) => territory.type === 'DISTRICT'), [territories]);
  const sectors = useMemo(() => territories.filter((territory) => territory.type === 'SECTOR' && territory.parentId === form.territoryId), [territories, form.territoryId]);
  const cells = useMemo(() => territories.filter((territory) => territory.type === 'CELL' && territory.parentId === form.sectorId), [territories, form.sectorId]);
  const villages = useMemo(() => territories.filter((territory) => territory.type === 'VILLAGE' && territory.parentId === form.cellId), [territories, form.cellId]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const [territoryResponse, agentResponse, usersResponse] = await Promise.all([
          api.get('/api/v1/territories'),
          isEdit ? api.get(`/api/v1/agents/${id}`) : Promise.resolve({ data: null }),
          ['ADMIN', 'MANAGER'].includes(user?.role) ? api.get('/api/v1/users', { params: { role: 'CHAMPION', limit: 100 } }) : Promise.resolve({ data: { data: [] } }),
        ]);
        if (!active) return;
        setTerritories(territoryResponse.data || []);
        setChampions(usersResponse.data.data || []);
        if (agentResponse.data) {
          const agent = agentResponse.data;
          setForm({
            agentId: agent.agentId || '', name: agent.name || '', phoneNumber: agent.phoneNumber || '',
            businessName: agent.businessName || '', address: agent.address || '', territoryId: agent.territoryId || '',
            nationalId: agent.personalDetails?.nationalId || '', nextOfKinName: agent.personalDetails?.nextOfKinName || '', nextOfKinPhone: agent.personalDetails?.nextOfKinPhone || '',
            sectorId: agent.sectorId || '', cellId: agent.cellId || '', villageId: agent.villageId || '', championId: agent.championId || '', status: agent.status || 'ACTIVE',
            registeredLatitude: agent.registeredLatitude ?? '', registeredLongitude: agent.registeredLongitude ?? '', gpsAccuracy: agent.gpsAccuracy ?? '',
          });
        }
      } catch (err) {
        if (active) setError(err.response?.data?.error || 'Could not load the agent form data.');
      } finally { if (active) setLoading(false); }
    };
    load();
    return () => { active = false; };
  }, [id, isEdit, user?.role]);

  const update = (key, value) => {
    if (['territoryId', 'sectorId', 'cellId', 'villageId'].includes(key)) setGpsRecaptured(false);
    setForm((current) => ({ ...current, [key]: value, ...(key === 'territoryId' ? { sectorId: '', cellId: '', villageId: '' } : {}), ...(key === 'sectorId' ? { cellId: '', villageId: '' } : {}), ...(key === 'cellId' ? { villageId: '' } : {}) }));
  };

  const captureLocation = () => {
    if (!navigator.geolocation) { setError('This browser does not support GPS location.'); return; }
    navigator.geolocation.getCurrentPosition((position) => {
      if (position.coords.accuracy > 20) { setError(`GPS accuracy is ±${Math.round(position.coords.accuracy)} m. Move to an open area and try again; 20 m or better is required.`); return; }
      update('registeredLatitude', position.coords.latitude.toFixed(6));
      update('registeredLongitude', position.coords.longitude.toFixed(6));
      update('gpsAccuracy', Math.round(position.coords.accuracy));
      setGpsRecaptured(true);
      setError('');
    }, (err) => setError(`Could not capture location: ${err.message}`), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!form.agentId.trim() || !form.name.trim() || !form.phoneNumber.trim() || !form.territoryId || !form.sectorId) {
      setError('Complete the agent identity, phone, district and sector. GPS can be captured during the first visit.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        agentId: form.agentId.trim(), name: form.name.trim(), phoneNumber: form.phoneNumber.trim(),
        businessName: form.businessName.trim() || null, address: form.address.trim() || null,
        ...(user?.role === 'ADMIN' ? { nationalId: form.nationalId.trim() || null, nextOfKinName: form.nextOfKinName.trim() || null, nextOfKinPhone: form.nextOfKinPhone.trim() || null } : {}),
        territoryId: form.territoryId, sectorId: form.sectorId || null, cellId: form.cellId || null, villageId: form.villageId || null, championId: form.championId || null,
        status: form.status, registeredLatitude: form.registeredLatitude === '' ? null : Number(form.registeredLatitude), registeredLongitude: form.registeredLongitude === '' ? null : Number(form.registeredLongitude),
        gpsAccuracy: form.gpsAccuracy === '' ? null : Number(form.gpsAccuracy), locationVerified: form.registeredLatitude !== '' && form.registeredLongitude !== '',
      };
      if (isEdit) {
        const existing = await api.get(`/api/v1/agents/${id}`);
        const territoryMoved = ['territoryId', 'sectorId', 'cellId', 'villageId'].some((field) => (payload[field] || null) !== (existing.data[field] || null));
        if (territoryMoved && user?.role === 'ADMIN' && !gpsRecaptured) throw new Error('Capture the agent’s new GPS position before changing their territory.');
        await api.put(`/api/v1/agents/${id}`, {
          ...payload,
          ...(territoryMoved ? { relocationConfirmed: gpsRecaptured, reason: locationReason.trim() } : {
            registeredLatitude: existing.data.registeredLatitude, registeredLongitude: existing.data.registeredLongitude,
            gpsAccuracy: existing.data.gpsAccuracy, locationVerified: existing.data.locationVerified,
          }),
        });
        const moved = payload.registeredLatitude != null && payload.registeredLongitude != null && (Number(existing.data.registeredLatitude) !== payload.registeredLatitude || Number(existing.data.registeredLongitude) !== payload.registeredLongitude);
        if (moved && !territoryMoved) await api.patch(`/api/v1/agents/${id}/location`, { latitude: payload.registeredLatitude, longitude: payload.registeredLongitude, accuracy: payload.gpsAccuracy, reason: locationReason.trim() || 'Updated through agent profile' });
        navigate(`/agents/${id}`);
      } else {
        const response = await api.post('/api/v1/agents', payload);
        navigate(`/agents/${response.data.id}`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save this agent. Check the details and try again.');
    } finally { setSaving(false); }
  };

  if (loading) return <LoadingState message="Loading agent form…" />;
  const assignedDistricts = user?.role === 'TC' && user.assignedTerritories?.length ? districts.filter((item) => user.assignedTerritories.some((assigned) => assigned.id === item.id)) : districts;
  const canEditAgentTerritory = !isEdit || user?.role === 'ADMIN';

  return <div className="agent-form-page page">
    <PageHeader title={isEdit ? 'Edit agent' : 'Register an agent'} subtitle="Maintain the identity, territory and registered visit location." breadcrumbs={[{ label: 'Agents', href: '/agents' }, { label: isEdit ? 'Edit agent' : 'New agent' }]} />
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <form className="agent-form-layout" onSubmit={submit}>
      <div className="agent-form-main">
        <section className="surface-card form-section">
          <div className="form-section-heading"><span className="detail-icon report-icon"><UsersRound size={17} /></span><div><h2>Agent information</h2><p>Identity and contact details used across field records.</p></div></div>
          <div className="form-grid-two">
            <FormField.Input label="Agent ID" value={form.agentId} onChange={(event) => update('agentId', event.target.value)} required disabled={isEdit} placeholder="e.g. AGT-0042" />
            <FormField.Input label="Full name" value={form.name} onChange={(event) => update('name', event.target.value)} required placeholder="Agent’s full name" />
            <FormField.Input type="tel" label="Phone number" value={form.phoneNumber} onChange={(event) => update('phoneNumber', event.target.value)} required placeholder="+250 …" />
            <FormField.Input label="Business name" value={form.businessName} onChange={(event) => update('businessName', event.target.value)} placeholder="Optional" />
            <div className="form-span-two"><FormField.Textarea label="Business address" value={form.address} onChange={(event) => update('address', event.target.value)} rows={2} placeholder="Street, landmark or directions" /></div>
            {user?.role === 'ADMIN' && <>
              <FormField.Input label="National ID" value={form.nationalId} onChange={(event) => update('nationalId', event.target.value)} placeholder="Stored encrypted" />
              <FormField.Input label="Next-of-kin name" value={form.nextOfKinName} onChange={(event) => update('nextOfKinName', event.target.value)} placeholder="Optional" />
              <FormField.Input type="tel" label="Next-of-kin phone" value={form.nextOfKinPhone} onChange={(event) => update('nextOfKinPhone', event.target.value)} placeholder="Optional" />
            </>}
          </div>
        </section>
        <section className="surface-card form-section">
          <div className="form-section-heading"><span className="detail-icon gps-icon"><MapPin size={17} /></span><div><h2>Territory & supervision</h2><p>Where the agent operates and who supports the sector.</p></div></div>
          <div className="form-grid-two">
            <FormField.Select label="District" value={form.territoryId} onChange={(event) => update('territoryId', event.target.value)} required disabled={!canEditAgentTerritory} options={[{ value: '', label: 'Select district' }, ...assignedDistricts.map((territory) => ({ value: territory.id, label: territory.name }))]} />
            <FormField.Select label="Sector" value={form.sectorId} onChange={(event) => update('sectorId', event.target.value)} required disabled={!canEditAgentTerritory} options={[{ value: '', label: 'Select sector' }, ...sectors.map((territory) => ({ value: territory.id, label: territory.name }))]} />
            <FormField.Select label="Cell" value={form.cellId} onChange={(event) => update('cellId', event.target.value)} disabled={!canEditAgentTerritory} options={[{ value: '', label: 'Select cell' }, ...cells.map((territory) => ({ value: territory.id, label: territory.name }))]} />
            <FormField.Select label="Village" value={form.villageId} onChange={(event) => update('villageId', event.target.value)} disabled={!canEditAgentTerritory} options={[{ value: '', label: 'Select village' }, ...villages.map((territory) => ({ value: territory.id, label: territory.name }))]} />
            {['ADMIN', 'MANAGER'].includes(user?.role) && <FormField.Select label="Champion" value={form.championId} onChange={(event) => update('championId', event.target.value)} options={[{ value: '', label: 'Unassigned' }, ...champions.map((champion) => ({ value: champion.id, label: `${champion.firstName} ${champion.lastName}` }))]} />}
            <FormField.Select label="Agent status" value={form.status} onChange={(event) => update('status', event.target.value)} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }, { value: 'SUSPENDED', label: 'Suspended' }, { value: 'PENDING', label: 'Pending' }]} />
          </div>
        </section>
        <section className="surface-card form-section">
          <div className="form-section-heading"><span className="detail-icon photo-icon"><MapPin size={17} /></span><div><h2>Registered GPS location</h2><p>This is the location used to verify in-person visits.</p></div></div>
          <div className="gps-capture-row"><div className="form-grid-two gps-fields">
            <FormField.Input type="number" step="any" label="Latitude" value={form.registeredLatitude} readOnly placeholder="Captured from GPS" />
            <FormField.Input type="number" step="any" label="Longitude" value={form.registeredLongitude} readOnly placeholder="Captured from GPS" />
          </div>{canEditAgentTerritory && <button type="button" className="btn btn-secondary capture-location-button" onClick={captureLocation}><LocateFixed size={16} />Use my location</button>}</div>
          {form.gpsAccuracy !== '' ? <p className="gps-accuracy-note">GPS accuracy at capture: ±{form.gpsAccuracy} m</p> : <p className="gps-accuracy-note">GPS can be recorded here or captured by the TC on the agent’s first visit.</p>}
          {isEdit && <div className="form-reason-field"><FormField.Input label="Reason for changing registered location" value={locationReason} onChange={(event) => setLocationReason(event.target.value)} placeholder="For example, agent moved to a new storefront" /></div>}
        </section>
        <div className="form-submit-row"><button type="button" className="btn btn-secondary" onClick={() => navigate(isEdit ? `/agents/${id}` : '/agents')}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}><Save size={16} />{saving ? 'Saving agent…' : isEdit ? 'Save changes' : 'Register agent'}</button></div>
      </div>
      <aside className="surface-card form-guidance"><span className="section-kicker">LOCATION QUALITY</span><h3>Capture the right place</h3><p>Register the agent’s business location. The system compares this point with the coordinator’s GPS at every check-in.</p><div className="guidance-check"><span>01</span><div><strong>Stand at the storefront</strong><small>Capture coordinates from the agent’s actual operating location.</small></div></div><div className="guidance-check"><span>02</span><div><strong>Keep accuracy in view</strong><small>A clear signal supports reliable distance verification.</small></div></div><div className="guidance-check"><span>03</span><div><strong>Record changes</strong><small>Location updates preserve a timestamped history for audit.</small></div></div></aside>
    </form>
  </div>;
}
