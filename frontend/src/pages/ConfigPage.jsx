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
  const [question, setQuestion] = useState({ text: '', type: 'TEXT', section: 'DDIN', options: '' });
  const [deleteId, setDeleteId] = useState(null);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [geofenceResult, checklistResult] = await Promise.allSettled([
        api.get('/api/v1/config/geofence'), api.get('/api/v1/config/checklist'),
      ]);
      const failures = [];
      if (geofenceResult.status === 'fulfilled') setRadius(geofenceResult.value.data.radiusMeters || 100);
      else failures.push(geofenceResult.reason.response?.data?.error || 'Could not load GPS settings.');
      if (checklistResult.status === 'fulfilled') {
        const schema = checklistResult.value.data.schema;
        const questions = Array.isArray(schema) ? schema : Array.isArray(schema?.questions) ? schema.questions : [];
        setChecklist(questions.map((item, index) => ({
          ...item,
          id: item.id || `question-${index + 1}`,
          order: item.order || index + 1,
          type: item.type || 'TEXT',
          section: item.section === 'IREMBO' ? 'IREMBO' : 'DDIN',
          required: item.section === 'IREMBO',
          options: Array.isArray(item.options) ? item.options : [],
        })));
      } else failures.push(checklistResult.reason.response?.data?.error || 'Could not load saved report questions.');
      if (failures.length) setError(failures.join(' '));
    } catch { setError('Could not load visit settings.'); }
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
      setChecklist(items.map((item, index) => ({ ...item, id: item.id || `question-${index + 1}`, order: item.order || index + 1, section: item.section || 'DDIN', required: item.section === 'IREMBO' })));
      setNotice('Visit report questions saved. IREMBO questions are required; DDIN questions are optional.');
    } catch (err) { setError(err.response?.data?.error || 'Could not save the visit checklist.'); }
    finally { setSaving(false); }
  };

  const addQuestion = () => {
    if (!question.text.trim()) return;
    const item = { id: globalThis.crypto?.randomUUID?.() || `q-${Date.now()}`, text: question.text.trim(), type: question.type, section: question.section, required: question.section === 'IREMBO', options: question.type === 'MULTIPLE_CHOICE' ? question.options.split(',').map((value) => value.trim()).filter(Boolean) : [] };
    setChecklist((items) => [...items, item]);
    setQuestion({ text: '', type: 'TEXT', section: 'DDIN', options: '' }); setShowAdd(false);
  };

  const moveQuestion = (index, direction) => {
    const next = [...checklist]; const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setChecklist(next);
  };

  const changeQuestionSection = (id, section) => {
    setChecklist((items) => items.map((item) => item.id === id
      ? { ...item, section, required: section === 'IREMBO' }
      : item));
  };

  if (loading) return <LoadingState message="Loading visit settings…" />;
  return <div className="config-page page">
    <PageHeader title="Visit settings" subtitle="Set the GPS verification radius and manage required IREMBO and optional DDIN report questions." />
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {notice && <div className="alert alert-success" role="status">{notice}</div>}
    <section className="config-layout">
      <article className="surface-card config-geofence-card"><div className="form-section-heading"><span className="detail-icon gps-icon"><MapPin size={17} /></span><div><h2>GPS geofence</h2><p>Maximum distance for a verified check-in.</p></div></div><div className="radius-input-row"><FormField.Input type="number" min="10" max="5000" label="Allowed radius (metres)" value={radius} onChange={(event) => setRadius(event.target.value)} /><span>m</span></div><div className="config-hint"><CircleHelp size={15} /><span>The Visits service calculates distance from device GPS to the agent’s registered coordinates. Non-verified readings are sent for review.</span></div><button className="btn btn-primary" onClick={saveGeofence} disabled={saving}><Save size={15} />{saving ? 'Saving…' : 'Save geofence'}</button></article>
      <article className="surface-card config-principle-card"><span className="section-kicker">VISIT INTEGRITY</span><h3>Location is collected at check-in</h3><p>Coordinators share GPS only as part of a visit. The system keeps the original agent location and visit coordinates with the report evidence.</p><div className="config-principle-foot">Radius changes are recorded in the audit trail.</div></article>
    </section>
    <section className="surface-card checklist-card"><div className="checklist-heading"><div><span className="section-kicker">REPORT TEMPLATE</span><h2>Visit report questions</h2><p>Questions below are loaded from the saved template. Keep, remove, reorder, or move them between Section A IREMBO (required) and Section B DDIN (optional). Changes apply to future reports; saved reports keep their original answers.</p></div><button className="btn btn-secondary btn-sm" onClick={() => setShowAdd((value) => !value)}><Plus size={14} />Add question</button></div>
      {showAdd && <div className="add-question-panel"><FormField.Input label="Question" value={question.text} onChange={(event) => setQuestion({ ...question, text: event.target.value })} placeholder="What should the coordinator record?" /><FormField.Select label="Report section" value={question.section} onChange={(event) => setQuestion({ ...question, section: event.target.value })} options={[{ value: 'IREMBO', label: 'Section A · IREMBO · Required' }, { value: 'DDIN', label: 'Section B · DDIN · Optional' }]} /><FormField.Select label="Answer type" value={question.type} onChange={(event) => setQuestion({ ...question, type: event.target.value })} options={[{ value: 'TEXT', label: 'Written response' }, { value: 'NUMBER', label: 'Number' }, { value: 'YES_NO', label: 'Yes / No' }, { value: 'MULTIPLE_CHOICE', label: 'Multiple choice' }]} />{question.type === 'MULTIPLE_CHOICE' && <FormField.Input label="Options" value={question.options} onChange={(event) => setQuestion({ ...question, options: event.target.value })} placeholder="Separate options with commas" />}<div className="flex justify-end gap-2"><button className="btn btn-secondary btn-sm" onClick={() => setShowAdd(false)}>Cancel</button><button className="btn btn-primary btn-sm" onClick={addQuestion} disabled={!question.text.trim()}>Add question</button></div></div>}
      {['IREMBO', 'DDIN'].map((section) => {
        const entries = checklist.map((item, index) => ({ item, index })).filter(({ item }) => (item.section || 'DDIN') === section);
        return <div className="checklist-section" key={section}><div className="checklist-section-heading"><div><h3>{section === 'IREMBO' ? 'Section A · IREMBO' : 'Section B · DDIN'}</h3><span>{section === 'IREMBO' ? 'Required questions' : 'Optional questions'}</span></div><strong>{entries.length}</strong></div>
          {entries.length ? <div className="checklist-items">{entries.map(({ item, index }, sectionIndex) => <div className="checklist-item" key={item.id}><div className="checklist-reorder"><button aria-label="Move question up" disabled={sectionIndex === 0 || saving} onClick={() => moveQuestion(index, -1)}><ArrowUp size={14} /></button><button aria-label="Move question down" disabled={sectionIndex === entries.length - 1 || saving} onClick={() => moveQuestion(index, 1)}><ArrowDown size={14} /></button></div><span className="checklist-order">{String(sectionIndex + 1).padStart(2, '0')}</span><div className="checklist-question"><strong>{item.text}</strong><small>{(item.type || 'TEXT').replaceAll('_', ' ')} · {section === 'IREMBO' ? 'Required' : 'Optional'}{item.options?.length ? ` · ${item.options.join(', ')}` : ''}</small></div><select className="input checklist-section-select" aria-label={`Section for ${item.text}`} value={item.section || section} onChange={(event) => changeQuestionSection(item.id, event.target.value)}><option value="IREMBO">Section A · IREMBO</option><option value="DDIN">Section B · DDIN</option></select><button className="delete-question" aria-label="Remove question" onClick={() => setDeleteId(item.id)}><Trash2 size={15} /></button></div>)}</div> : <div className="detail-empty">No {section} questions configured.</div>}
        </div>;
      })}
      <div className="checklist-save-row"><span>{checklist.length} configured question{checklist.length === 1 ? '' : 's'}</span><button className="btn btn-primary" onClick={() => saveChecklist(checklist)} disabled={saving}><Save size={15} />{saving ? 'Saving…' : 'Save questions'}</button></div>
    </section>
    <ConfirmDialog isOpen={Boolean(deleteId)} title="Remove checklist question?" message="After you save the template, this question will no longer appear in new reports. Answers already saved in visit reports will remain unchanged." confirmText="Remove question" onConfirm={() => { const next = checklist.filter((item) => item.id !== deleteId); setChecklist(next); setDeleteId(null); }} onCancel={() => setDeleteId(null)} />
  </div>;
}
