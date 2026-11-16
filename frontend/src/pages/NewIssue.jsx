import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Send } from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, LoadingState } from '../components';
import { useToast } from '../components/Toast';
import { ISSUE_CATEGORIES, ISSUE_NETWORKS, ISSUE_PRIORITIES, personName } from '../issues';
import '../issues.css';

const blank = { title: '', description: '', category: 'REQUEST', priority: 'NORMAL', network: 'IREMBO', assignedToId: '', agentName: '', agentPhone: '', agentCode: '', province: '', district: '', sector: '', cell: '', village: '' };

export default function NewIssue() {
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState(blank);
  const [admins, setAdmins] = useState([]);
  const [loadingAdmins, setLoadingAdmins] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  useEffect(() => {
    api.get('/api/v1/issues/admins').then(({ data }) => setAdmins(data.data || []))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the administrator list.'))
      .finally(() => setLoadingAdmins(false));
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (form.title.trim().length < 3 || !form.description.trim() || !form.assignedToId) return;
    setSaving(true);
    setError('');
    try {
      const { data } = await api.post('/api/v1/issues', form);
      toast.addToast(`${data.data.code} sent to the administrator.`, 'success');
      navigate(`/issues/${data.data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send this issue. Please retry.');
    } finally {
      setSaving(false);
    }
  };

  if (loadingAdmins) return <div className="page"><PageHeader title="Report an issue" subtitle="Send an agent’s problem to an administrator and follow the progress." /><LoadingState message="Loading administrators…" /></div>;
  return <div className="page issues-page">
    <PageHeader title="Report an issue" subtitle="Give the administrator enough detail to investigate the agent’s problem." breadcrumbs={[{ label: 'Issues', href: '/issues' }, { label: 'New report' }]} actions={<button className="btn btn-secondary" onClick={() => navigate('/issues')}><ArrowLeft size={15} />All issues</button>} />
    {admins.length === 0 && <ErrorState message="There are no active administrator accounts to receive an issue. Contact your system administrator." />}
    <form className="issue-form" onSubmit={submit}>
      <section className="surface-card issue-form-card">
        <div className="issue-form-section-title"><span>01</span><div><h2>Describe the problem</h2><p>Give it a clear title and include what happened and what help is needed.</p></div></div>
        <div className="issue-form-grid">
          <label className="issue-field issue-field-wide"><span>Issue title <b>*</b></span><input className="input" value={form.title} onChange={set('title')} maxLength={200} required minLength={3} placeholder="For example: Agent cannot access their account" /></label>
          <label className="issue-field"><span>Type of problem</span><select className="input" value={form.category} onChange={set('category')}>{ISSUE_CATEGORIES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="issue-field"><span>Priority</span><select className="input" value={form.priority} onChange={set('priority')}>{ISSUE_PRIORITIES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="issue-field"><span>Network</span><select className="input" value={form.network} onChange={set('network')}>{ISSUE_NETWORKS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="issue-field issue-field-wide"><span>What happened and what is needed? <b>*</b></span><textarea className="input issue-description" value={form.description} onChange={set('description')} maxLength={5000} required rows={5} placeholder="Include when the problem began and any steps already taken." /></label>
        </div>
      </section>

      <section className="surface-card issue-form-card">
        <div className="issue-form-section-title"><span>02</span><div><h2>Agent and location</h2><p>Add whatever details you have so the team can identify the agent quickly.</p></div></div>
        <div className="issue-form-grid">
          <label className="issue-field"><span>Agent’s name</span><input className="input" value={form.agentName} onChange={set('agentName')} maxLength={200} /></label>
          <label className="issue-field"><span>Agent’s phone</span><input className="input" value={form.agentPhone} onChange={set('agentPhone')} inputMode="tel" maxLength={32} placeholder="07X XXX XXXX" /></label>
          <label className="issue-field"><span>Agent code</span><input className="input" value={form.agentCode} onChange={set('agentCode')} maxLength={80} /></label>
          <label className="issue-field"><span>Province</span><input className="input" value={form.province} onChange={set('province')} maxLength={80} /></label>
          <label className="issue-field"><span>District</span><input className="input" value={form.district} onChange={set('district')} maxLength={80} /></label>
          <label className="issue-field"><span>Sector</span><input className="input" value={form.sector} onChange={set('sector')} maxLength={80} /></label>
          <label className="issue-field"><span>Cell</span><input className="input" value={form.cell} onChange={set('cell')} maxLength={80} /></label>
          <label className="issue-field"><span>Village</span><input className="input" value={form.village} onChange={set('village')} maxLength={80} /></label>
        </div>
      </section>

      <section className="surface-card issue-form-card">
        <div className="issue-form-section-title"><span>03</span><div><h2>Send it to an administrator</h2><p>The selected administrator will own the response and update the progress.</p></div></div>
        <label className="issue-field"><span>Administrator <b>*</b></span><select className="input" value={form.assignedToId} onChange={set('assignedToId')} required><option value="">Choose an administrator</option>{admins.map((admin) => <option value={admin.id} key={admin.id}>{personName(admin)}</option>)}</select></label>
      </section>

      {error && <div className="alert-error" role="alert">{error}</div>}
      <div className="issue-form-actions"><button type="button" className="btn btn-secondary" onClick={() => navigate('/issues')}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || admins.length === 0 || !form.assignedToId}>{saving ? 'Sending…' : <><Send size={15} />Send issue</>}</button></div>
    </form>
  </div>;
}
