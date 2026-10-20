import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, CircleHelp, MapPin, Plus, Save, Trash2 } from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import FormField from '../components/FormField';
import { ConfirmDialog, LoadingState } from '../components';

export default function ConfigPage() {
  const [radius, setRadius] = useState(100);
  const [checklist, setChecklist] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [question, setQuestion] = useState({ text: '', type: 'TEXT', options: '' });
  const [deleteId, setDeleteId] = useState(null);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [geofenceResponse, checklistResponse] = await Promise.all([
        api.get('/api/v1/config/geofence'), api.get('/api/v1/config/checklist'),
      ]);
      setRadius(geofenceResponse.data.radiusMeters || 100);
      const schema = checklistResponse.data.schema;
      const questions = Array.isArray(schema) ? schema : Array.isArray(schema?.questions) ? schema.questions : [];
      setChecklist(questions.map((item, index) => ({ id: item.id || `question-${index + 1}`, order: item.order || index + 1, type: item.type || 'TEXT', ...item })));
    } catch (err) { setError(err.response?.data?.error || 'Could not load visit settings.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const saveGeofence = async () => {
    const radiusMeters = Number(radius);
    if (!Number.isFinite(radiusMeters) || radiusMeters < 10 || radiusMeters > 5000) { setError('Enter a radius between 10 and 5,000 metres.'); return; }
    setSaving(true); setError(''); setNotice('');
    try { const { data } = await api.put('/api/v1/config/geofence', { radiusMeters }); setRadius(data.radiusMeters); setNotice('Geofence radius saved.'); }
    catch (err) { setError(err.response?.data?.error || 'Could not save geofence settings.'); }
    finally { setSaving(false); }
  };

  const saveChecklist = async (nextChecklist) => {
    setSaving(true); setError(''); setNotice('');
    try {
      const schema = nextChecklist.map((item, index) => ({ ...item, order: index + 1 }));
      const { data } = await api.put('/api/v1/config/checklist', { schema });
      const items = Array.isArray(data.schema) ? data.schema : [];
      setChecklist(items.map((item, index) => ({ ...item, id: item.id || `question-${index + 1}`, order: item.order || index + 1 })));
      setNotice('Visit checklist saved.');
    } catch (err) { setError(err.response?.data?.error || 'Could not save the visit checklist.'); }
    finally { setSaving(false); }
  };

  const addQuestion = () => {
    if (!question.text.trim()) return;
    const item = { id: crypto.randomUUID(), text: question.text.trim(), type: question.type, options: question.type === 'MULTIPLE_CHOICE' ? question.options.split(',').map((value) => value.trim()).filter(Boolean) : [] };
    setChecklist((items) => [...items, item]);
    setQuestion({ text: '', type: 'TEXT', options: '' }); setShowAdd(false);
  };

  const moveQuestion = (index, direction) => {
    const next = [...checklist]; const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setChecklist(next);
  };

  if (loading) return <LoadingState message="Loading visit settings…" />;
  return <div className="config-page page">
    <PageHeader title="Visit settings" subtitle="Set the GPS verification radius and the checklist coordinators complete during visits." />
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {notice && <div className="alert alert-success" role="status">{notice}</div>}
    <section className="config-layout">
      <article className="surface-card config-geofence-card"><div className="form-section-heading"><span className="detail-icon gps-icon"><MapPin size={17} /></span><div><h2>GPS geofence</h2><p>Maximum distance for a verified check-in.</p></div></div><div className="radius-input-row"><FormField.Input type="number" min="10" max="5000" label="Allowed radius (metres)" value={radius} onChange={(event) => setRadius(event.target.value)} /><span>m</span></div><div className="config-hint"><CircleHelp size={15} /><span>The Visits service calculates distance from device GPS to the agent’s registered coordinates. Non-verified readings are sent for review.</span></div><button className="btn btn-primary" onClick={saveGeofence} disabled={saving}><Save size={15} />{saving ? 'Saving…' : 'Save geofence'}</button></article>
      <article className="surface-card config-principle-card"><span className="section-kicker">VISIT INTEGRITY</span><h3>Location is collected at check-in</h3><p>Coordinators share GPS only as part of a visit. The system keeps the original agent location and visit coordinates with the report evidence.</p><div className="config-principle-foot">Radius changes are recorded in the audit trail.</div></article>
    </section>
    <section className="surface-card checklist-card"><div className="checklist-heading"><div><span className="section-kicker">REPORT TEMPLATE</span><h2>Visit checklist</h2><p>Questions shown to coordinators when they submit a visit report.</p></div><button className="btn btn-secondary btn-sm" onClick={() => setShowAdd((value) => !value)}><Plus size={14} />Add question</button></div>
      {showAdd && <div className="add-question-panel"><FormField.Input label="Question" value={question.text} onChange={(event) => setQuestion({ ...question, text: event.target.value })} placeholder="What should the coordinator record?" /><FormField.Select label="Answer type" value={question.type} onChange={(event) => setQuestion({ ...question, type: event.target.value })} options={[{ value: 'TEXT', label: 'Written response' }, { value: 'YES_NO', label: 'Yes / No' }, { value: 'MULTIPLE_CHOICE', label: 'Multiple choice' }]} />{question.type === 'MULTIPLE_CHOICE' && <FormField.Input label="Options" value={question.options} onChange={(event) => setQuestion({ ...question, options: event.target.value })} placeholder="Separate options with commas" />}<div className="flex justify-end gap-2"><button className="btn btn-secondary btn-sm" onClick={() => setShowAdd(false)}>Cancel</button><button className="btn btn-primary btn-sm" onClick={addQuestion}>Add to checklist</button></div></div>}
      <div className="checklist-items">{checklist.length ? checklist.map((item, index) => <div className="checklist-item" key={item.id}><div className="checklist-reorder"><button aria-label="Move question up" disabled={index === 0} onClick={() => moveQuestion(index, -1)}><ArrowUp size={14} /></button><button aria-label="Move question down" disabled={index === checklist.length - 1} onClick={() => moveQuestion(index, 1)}><ArrowDown size={14} /></button></div><span className="checklist-order">{String(index + 1).padStart(2, '0')}</span><div className="checklist-question"><strong>{item.text}</strong><small>{(item.type || 'TEXT').replaceAll('_', ' ')}{item.options?.length ? ` · ${item.options.join(', ')}` : ''}</small></div><button className="delete-question" aria-label="Remove question" onClick={() => setDeleteId(item.id)}><Trash2 size={15} /></button></div>) : <div className="detail-empty">No extra checklist questions are configured yet.</div>}</div>
      <div className="checklist-save-row"><span>{checklist.length} configurable question{checklist.length === 1 ? '' : 's'}</span><button className="btn btn-primary" onClick={() => saveChecklist(checklist)} disabled={saving}><Save size={15} />{saving ? 'Saving…' : 'Save checklist'}</button></div>
    </section>
    <ConfirmDialog isOpen={Boolean(deleteId)} title="Remove checklist question?" message="This question will be removed from future visit reports." confirmText="Remove question" onConfirm={() => { const next = checklist.filter((item) => item.id !== deleteId); setChecklist(next); setDeleteId(null); }} onCancel={() => setDeleteId(null)} />
  </div>;
}
