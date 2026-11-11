import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { PlanPanel, TerritoryExplorer } from '../components/FieldPerformance';
import PageHeader from '../components/PageHeader';

const kigaliDateKey = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

export default function FieldPlans() {
  const navigate = useNavigate();
  const planNetwork = 'COMBINED';
  const today = kigaliDateKey();
  const month = today.slice(0, 7);
  const [explorer, setExplorer] = useState(null);
  const [explorerLoading, setExplorerLoading] = useState(true);
  const [explorerError, setExplorerError] = useState('');
  const [territoryId, setTerritoryId] = useState('');
  const [area, setArea] = useState(null);
  const [plans, setPlans] = useState([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadExplorer = useCallback(async (signal) => {
    setExplorerLoading(true);
    setExplorerError('');
    try {
      const { data } = await api.get('/api/v1/reports/field-progress/explorer', {
        params: { fromDate: `${month}-01`, toDate: today, network: planNetwork, ...(territoryId ? { territoryId } : {}) },
        signal,
      });
      if (!signal?.aborted) setExplorer(data);
    } catch (err) {
      if (!signal?.aborted) setExplorerError(err.response?.data?.error || 'Could not load your assigned areas.');
    } finally {
      if (!signal?.aborted) setExplorerLoading(false);
    }
  }, [month, territoryId, today]);

  const loadPlans = useCallback(async () => {
    setPlansLoading(true);
    setError('');
    try {
      const { data } = await api.get('/api/v1/reports/field-progress/plans', { params: { month, network: planNetwork } });
      setPlans(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load field plans.');
    } finally {
      setPlansLoading(false);
    }
  }, [month]);

  useEffect(() => {
    const controller = new AbortController();
    loadExplorer(controller.signal);
    return () => controller.abort();
  }, [loadExplorer]);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  const openTerritory = useCallback((id) => setTerritoryId(id || ''), []);
  const selectPlanArea = useCallback((selectedArea) => {
    setArea(selectedArea);
    setError('');
  }, []);

  const savePlan = useCallback(async (payload) => {
    setSaving(true);
    setError('');
    try {
      await api.put('/api/v1/reports/field-progress/plans', payload);
      await loadPlans();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save this field plan.');
      return false;
    } finally {
      setSaving(false);
    }
  }, [loadPlans]);

  const deletePlan = useCallback(async (id) => {
    setError('');
    try {
      await api.delete(`/api/v1/reports/field-progress/plans/${id}`);
      await loadPlans();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove this field plan.');
    }
  }, [loadPlans]);

  return <div className="field-performance-view page">
    <PageHeader
      title="Combined field plans"
      subtitle="Plan one route across Irembo and Moola Plus agents. Duplicate people with the same registered phone number are counted once."
      breadcrumbs={[{ label: 'Workspace', href: '/dashboard' }, { label: 'Visits', href: '/visits' }, { label: 'Field plans' }]}
    />
    <section className="field-progress-grid field-progress-grid-bottom">
      <TerritoryExplorer
        role="TC"
        data={explorer}
        loading={explorerLoading}
        error={explorerError}
        reload={() => loadExplorer()}
        openTerritory={openTerritory}
        selectPlanArea={selectPlanArea}
        navigate={navigate}
        allowPlanning
      />
      <PlanPanel
        network={planNetwork}
        month={month}
        plans={plans}
        area={area}
        onSave={(payload) => savePlan({ ...payload, network: planNetwork })}
        onDelete={deletePlan}
        saving={saving}
        loading={plansLoading}
        error={error}
        setError={setError}
      />
    </section>
  </div>;
}
