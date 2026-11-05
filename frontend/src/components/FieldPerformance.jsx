import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, CalendarDays, ChevronRight, ClipboardList, LocateFixed, MapPin, MapPinned,
  Sparkles, Target, Trash2, TrendingUp, UsersRound,
} from 'lucide-react';
import api from '../api';
import { ErrorState, LoadingState } from './index';

const TARGET_PER_DAY = 6;
const areaLabels = { PROVINCE: 'Province', DISTRICT: 'District', SECTOR: 'Sector', CELL: 'Cell', VILLAGE: 'Village' };
const reportDate = (value) => value ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Kigali' }).format(new Date(value)) : '—';
const currentKigaliDate = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const currentKigaliMonth = () => currentKigaliDate().slice(0, 7);
const monthLastDay = (month) => {
  const [year, monthNumber] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, '0')}`;
};
const monthLabel = (month) => month ? new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00.000Z`)) : '';
const percent = (value) => `${Math.round(Number(value) || 0)}%`;
const clampPercent = (value) => Math.max(0, Math.min(100, Number(value) || 0));
const planTerritoryName = (territory) => territory?.fullPath || territory?.name || 'Territory';
const planTerritoryPath = (territory) => {
  const path = [];
  let current = territory;
  while (current) { path.unshift(current.name); current = current.parent; }
  return path.join(' · ');
};

function Metric({ icon: Icon, label, value, detail, tone = 'green' }) {
  return <article className={`field-progress-metric tone-${tone}`}>
    <span className="field-progress-metric-icon"><Icon size={18} aria-hidden="true" /></span>
    <span className="field-progress-metric-copy"><small>{label}</small><strong>{value}</strong><span>{detail}</span></span>
  </article>;
}

function ProgressTrack({ value, tone = '' }) {
  return <span className={`field-progress-track${tone ? ` ${tone}` : ''}`} aria-label={`${percent(value)} coverage`}>
    <span style={{ width: `${clampPercent(value)}%` }} />
  </span>;
}

function DailyChart({ data = [], target = TARGET_PER_DAY, title = 'Daily unique agents visited' }) {
  const width = 760;
  const height = 220;
  const padding = { top: 16, right: 14, bottom: 30, left: 42 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(target + 2, ...data.map(({ agentsVisited }) => agentsVisited));
  const y = (value) => padding.top + plotHeight - (value / maxValue) * plotHeight;
  const step = data.length > 1 ? plotWidth / data.length : plotWidth;
  const barWidth = Math.max(3, Math.min(17, step * 0.58));
  const targetY = y(target);
  const yTicks = [...new Set([0, 1, 2, 3, 4, target, Math.ceil(maxValue)])].filter((tick) => tick <= maxValue).sort((a, b) => a - b);
  return <div className="field-chart-wrap">
    <svg className="field-daily-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}. A dotted line marks the minimum target of ${target} agents per field day.`}>
      {yTicks.map((tick) => <g key={tick}>
        <line x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} className="field-chart-gridline" />
        <text x={padding.left - 9} y={y(tick) + 4} textAnchor="end" className="field-chart-axis-label">{tick}</text>
      </g>)}
      <line x1={padding.left} x2={width - padding.right} y1={targetY} y2={targetY} className="field-chart-target" />
      {data.map((entry, index) => {
        const x = padding.left + index * step + (step - barWidth) / 2;
        const barHeight = Math.max(0, (entry.agentsVisited / maxValue) * plotHeight);
        const showLabel = index === 0 || entry.label % 5 === 0 || index === data.length - 1;
        return <g key={entry.date}>
          <rect x={x} y={padding.top + plotHeight - barHeight} width={barWidth} height={barHeight} rx="3" className={entry.agentsVisited >= target ? 'field-chart-bar on-target' : 'field-chart-bar'}>
            <title>{`${reportDate(`${entry.date}T12:00:00`)}: ${entry.agentsVisited} unique agents, ${entry.visits} completed visits, ${entry.fieldActions} other field actions`}</title>
          </rect>
          {showLabel && <text x={x + barWidth / 2} y={height - 8} textAnchor="middle" className="field-chart-axis-label">{entry.label}</text>}
        </g>;
      })}
    </svg>
    <div className="field-chart-legend"><span><i className="field-chart-legend-swatch" />Unique agents visited</span><span><i className="field-chart-legend-target" />Minimum: {target} per field day</span></div>
  </div>;
}

function WeekdayChart({ data = [], target = TARGET_PER_DAY }) {
  const width = 520;
  const height = 180;
  const padding = { top: 14, right: 8, bottom: 30, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(target + 2, ...data.map(({ averageAgents }) => averageAgents));
  const y = (value) => padding.top + plotHeight - (value / maxValue) * plotHeight;
  const step = data.length ? plotWidth / data.length : plotWidth;
  const barWidth = Math.min(35, step * 0.55);
  const targetY = y(target);
  return <div className="field-chart-wrap">
    <svg className="field-weekday-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Average unique agents visited by weekday. The dotted line marks a minimum of ${target} agents per field day.`}>
      {[...new Set([0, 2, 4, 6, Math.ceil(maxValue), target])].filter((tick) => tick <= maxValue).sort((a, b) => a - b).map((tick) => <g key={tick}>
        <line x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} className="field-chart-gridline" />
        <text x={padding.left - 8} y={y(tick) + 4} textAnchor="end" className="field-chart-axis-label">{tick}</text>
      </g>)}
      <line x1={padding.left} x2={width - padding.right} y1={targetY} y2={targetY} className="field-chart-target" />
      {data.map((entry, index) => {
        const x = padding.left + index * step + (step - barWidth) / 2;
        const barHeight = Math.max(0, (entry.averageAgents / maxValue) * plotHeight);
        return <g key={entry.day}>
          <rect x={x} y={padding.top + plotHeight - barHeight} width={barWidth} height={barHeight} rx="4" className={entry.averageAgents >= target ? 'field-chart-bar on-target' : 'field-chart-bar'}>
            <title>{`${entry.day}: ${entry.averageAgents} average agents per day across ${entry.days} calendar dates`}</title>
          </rect>
          <text x={x + barWidth / 2} y={height - 8} textAnchor="middle" className="field-chart-axis-label">{entry.day.slice(0, 3)}</text>
        </g>;
      })}
    </svg>
  </div>;
}

function Breadcrumbs({ items, onRoot, onChoose }) {
  return <nav className="field-breadcrumbs" aria-label="Territory path">
    <button type="button" onClick={onRoot}>All areas</button>
    {items.map((item, index) => <React.Fragment key={item.id}>
      <ChevronRight size={14} aria-hidden="true" />
      <button type="button" aria-current={index === items.length - 1 ? 'location' : undefined} onClick={() => onChoose(item, index)}>{item.name}</button>
    </React.Fragment>)}
  </nav>;
}

function TerritoryExplorer({
  role, data, loading, error, reload, openTerritory, selectPlanArea, navigate,
}) {
  const breadcrumbs = data?.breadcrumbs || [];
  const children = data?.children || [];
  const agents = data?.agents || [];
  const selectedArea = data?.selectedArea;
  return <section className="surface-card field-explorer-card">
    <div className="field-section-heading">
      <div><span className="section-kicker">AREA BY AREA</span><h3>Territory explorer</h3><p>Open a province, then narrow through districts, sectors, cells and villages to the agents.</p></div>
      <span className="field-section-icon"><MapPinned size={18} /></span>
    </div>
    <div className="field-explorer-body">
      <Breadcrumbs items={breadcrumbs} onRoot={() => openTerritory(null)} onChoose={(item) => openTerritory(item.id)} />
      {selectedArea && <div className="field-current-area">
        <div><span>{areaLabels[selectedArea.type] || 'Area'}</span><strong>{selectedArea.name}</strong><small>{selectedArea.visitedAgents} of {selectedArea.totalAgents} active agents visited in the selected period</small></div>
        <div className="field-current-area-rate"><strong>{percent(selectedArea.coveragePercentage)}</strong><ProgressTrack value={selectedArea.coveragePercentage} /></div>
        {role === 'TC' && <button className="btn btn-secondary btn-sm" type="button" onClick={() => selectPlanArea({ ...selectedArea, fullPath: breadcrumbs.map(({ name }) => name).join(' · ') })}><CalendarDays size={15} />Plan here</button>}
      </div>}
      {error && <ErrorState message={error} onRetry={reload} />}
      {loading ? <LoadingState message="Loading this area…" /> : !error && <>
        {children.length > 0 ? <div className="field-area-list" role="list">
          {children.map((area) => <div className="field-area-row" role="listitem" key={area.id}>
            <button className="field-area-main" type="button" onClick={() => openTerritory(area.id)}>
              <span className="field-area-type">{areaLabels[area.type] || 'Area'}</span>
              <span className="field-area-name"><strong>{area.name}</strong><small>{area.visitedAgents} visited · {area.remainingAgents} left · {area.visits} visits</small></span>
              <span className="field-area-progress"><strong>{percent(area.coveragePercentage)}</strong><ProgressTrack value={area.coveragePercentage} /></span>
              <ChevronRight size={17} className="field-area-chevron" />
            </button>
            {role === 'TC' && <button className="field-area-plan" type="button" onClick={() => selectPlanArea({ ...area, fullPath: [...breadcrumbs.map(({ name }) => name), area.name].join(' · ') })} aria-label={`Plan a visit in ${area.name}`} title={`Plan a visit in ${area.name}`}><CalendarDays size={15} /></button>}
          </div>)}
        </div> : selectedArea ? <div className="field-explorer-empty"><MapPin size={19} /><strong>No smaller areas are registered here yet.</strong><span>Agents assigned directly to this area are listed below when available.</span></div>
          : <div className="field-explorer-empty"><MapPin size={19} /><strong>No territories are available.</strong><span>Active assigned areas will appear here.</span></div>}
        {agents.length > 0 && <div className="field-agent-list-wrap">
          <div className="field-agent-list-heading"><div><strong>Agents in this area</strong><span>{agents.length} active agents · selected-period status</span></div><UsersRound size={16} /></div>
          <div className="field-area-agents">
            {agents.map((agent) => <button type="button" className="field-area-agent" key={agent.id} onClick={() => navigate(`/agents/${agent.id}`)}>
              <span className="field-agent-avatar">{(agent.name || 'A').slice(0, 1).toUpperCase()}</span>
              <span className="field-area-agent-copy"><strong>{agent.name}</strong><small>{agent.agentId}{agent.businessName ? ` · ${agent.businessName}` : ''}{agent.venue ? ` · ${agent.venue}` : ''}</small></span>
              <span className={`field-agent-visit-status${agent.visitedInRange ? ' is-visited' : ''}`}>{agent.visitedInRange ? `${agent.visitCount} visit${agent.visitCount === 1 ? '' : 's'} in period` : 'Not visited in period'}</span>
              <ArrowRight size={14} />
            </button>)}
          </div>
        </div>}
      </>}
    </div>
  </section>;
}

function PlanPanel({ month, plans, area, onSave, onDelete, saving, loading, error, setError, minimumAgentsPerDay = 1 }) {
  const today = currentKigaliDate();
  const activeMonth = month === currentKigaliMonth();
  const [planDate, setPlanDate] = useState(today);
  const [targetAgents, setTargetAgents] = useState(Math.max(1, minimumAgentsPerDay));
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (planDate < today || planDate.slice(0, 7) !== month) setPlanDate(today.slice(0, 7) === month ? today : `${month}-01`);
  }, [month, planDate, today]);

  useEffect(() => { setTargetAgents(Math.max(1, minimumAgentsPerDay)); }, [minimumAgentsPerDay]);

  const submit = async (event) => {
    event.preventDefault();
    if (!area) { setError('Choose a territory in the explorer before saving a plan.'); return; }
    if (await onSave({ planDate, territoryId: area.id, targetAgents: Number(targetAgents), notes })) setNotes('');
  };

  return <section className="surface-card field-plan-card">
    <div className="field-section-heading">
      <div><span className="section-kicker">MAKE A FIELD PLAN</span><h3>Plan your next day</h3><p>Choose an area in the explorer and set a realistic agent target.</p></div>
      <span className="field-section-icon field-plan-icon"><ClipboardList size={18} /></span>
    </div>
    <div className="field-plan-body">
      {!activeMonth ? <div className="field-plan-guidance"><CalendarDays size={17} /><span>Planning is open for {monthLabel(currentKigaliMonth())}. Select this month to add or update upcoming field days.</span></div> : <>
        <div className="field-plan-selected-area"><MapPin size={15} /><span>{area ? <><small>{areaLabels[area.type] || 'Area'}</small><strong>{planTerritoryName(area)}</strong></> : <span>Choose an area above</span>}</span></div>
        <form onSubmit={submit} className="field-plan-form">
          <label><span>Field day</span><input type="date" value={planDate} min={today} max={monthLastDay(month)} onChange={(event) => setPlanDate(event.target.value)} required /></label>
          <label><span>Agent target</span><input type="number" min="1" max="500" step="1" value={targetAgents} onChange={(event) => setTargetAgents(event.target.value)} required /></label>
          <label className="field-plan-notes"><span>Route note (optional)</span><input type="text" value={notes} maxLength="500" onChange={(event) => setNotes(event.target.value)} placeholder="Starting point, route, or follow-up" /></label>
          {error && <p className="field-plan-error" role="alert">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={saving || !area}><CalendarDays size={15} />{saving ? 'Saving plan…' : 'Save field plan'}</button>
        </form>
      </>}
      <div className="field-plan-list-heading"><div><strong>{monthLabel(month)} plans</strong><span>{loading ? 'Loading field plans…' : `${plans.length} planned field day${plans.length === 1 ? '' : 's'}`}</span></div></div>
      {loading ? <div className="field-plan-empty">Loading this month’s plans…</div> : plans.length ? <ul className="field-plan-list">{plans.map((plan) => {
        const dateKey = String(plan.planDate).slice(0, 10);
        const planIsActive = dateKey <= today;
        const progressText = planIsActive
          ? `${plan.actualAgentsReached || 0} / ${plan.targetAgents} reached · ${plan.hitTarget ? 'goal met' : 'below goal'}`
          : `goal ${plan.targetAgents} · planned`;
        return <li key={plan.id}>
          <span className="field-plan-date"><strong>{dateKey.slice(8, 10)}</strong><small>{new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(new Date(plan.planDate))}</small></span>
          <span className="field-plan-detail"><strong>{plan.territory?.name || 'Territory'}</strong><small title={planTerritoryPath(plan.territory)}>{areaLabels[plan.territory?.type] || 'Area'} · {progressText}{plan.notes ? ` · ${plan.notes}` : ''}</small></span>
          <button type="button" className="field-plan-delete" onClick={() => onDelete(plan.id)} title="Remove this plan" aria-label={`Remove plan for ${reportDate(plan.planDate)}`}><Trash2 size={15} /></button>
        </li>;
      })}</ul> : <div className="field-plan-empty">No field days planned for this month yet.</div>}
      {error && !activeMonth && <p className="field-plan-error" role="alert">{error}</p>}
    </div>
  </section>;
}

function CoachingCard({ summary, focus }) {
  const dailyMinimum = summary.minimumAgentsPerDay ?? summary.targetPerFieldDay ?? TARGET_PER_DAY;
  let message;
  let title;
  let tone = 'good';
  if (!summary.totalAgents) {
    title = 'No active agents in your assigned areas';
    message = 'Ask your manager to review your active district assignments or agent roster.';
    tone = 'neutral';
  } else if (!summary.remainingAgents) {
    title = 'Every active agent was reached in this period';
    message = 'Keep completing scheduled follow-ups and use the territory explorer to check for missed field details.';
  } else if (summary.averageAgentsPerFieldDay < dailyMinimum) {
    title = `Plan for at least ${dailyMinimum} agents each field day`;
    message = `Your territory has ${summary.totalAgents} active agents to cover within three months. Prioritize ${focus?.territoryName || 'your least-covered area'} and plan a focused route.`;
    tone = 'attention';
  } else if (summary.averageAgentsPerFieldDay >= dailyMinimum) {
    title = 'Your field-day pace is on target';
    message = `${summary.averageAgentsPerFieldDay} unique agents per field day so far, meeting the minimum of ${dailyMinimum}. Next, focus on ${focus?.territoryName || 'the area with the most agents still uncovered'}.`;
  } else {
    title = 'A focused route can lift your daily pace';
    message = `You are averaging ${summary.averageAgentsPerFieldDay} unique agents per field day. Plan a route in ${focus?.territoryName || 'a low-coverage area'} to reach the minimum of ${dailyMinimum}.`;
    tone = 'attention';
  }
  return <article className={`field-coaching-card ${tone}`}>
    <div className="field-coaching-icon">{tone === 'attention' ? <AlertTriangle size={18} /> : <Sparkles size={18} />}</div>
    <div><span className="section-kicker">YOUR NEXT BEST MOVE</span><h3>{title}</h3><p>{message}</p>
      {summary.totalAgents > 0 && <small>{summary.totalAgents} active agents · minimum {dailyMinimum} per weekday · full roster due by {summary.coverageWindowEnd || 'the end of three months'}</small>}
    </div>
  </article>;
}

function TCView({ data, explorer, explorerState, plansState, planMonth, periodLabel, openTerritory, selectPlanArea, savePlan, deletePlan, navigate }) {
  const summary = data?.summary || {};
  const focus = data?.focusAreas?.[0];
  return <div className="field-performance-view">
    <section className="field-performance-banner">
      <div><span className="field-banner-eyebrow"><Activity size={14} /> TC FIELD PULSE · {periodLabel}</span><h2>Your work, mapped to the selected dates</h2><p>Track unique-agent coverage, spot areas that need attention, and plan the next route.</p></div>
    </section>
    <section className="field-progress-metrics" aria-label="Field progress in the selected dates">
      <Metric icon={UsersRound} label="Agents covered" value={`${summary.visitedAgents || 0} / ${summary.totalAgents || 0}`} detail={`${percent(summary.coveragePercentage)} of active agents`} tone="orange" />
      <Metric icon={Target} label="Minimum per field day" value={`${summary.minimumAgentsPerDay || 0}`} detail={`${summary.totalAgents || 0} active agents · cover in three months`} tone="green" />
      <Metric icon={TrendingUp} label="Average on field days" value={`${summary.averageAgentsPerFieldDay || 0}`} detail={`${summary.daysMeetingTarget || 0} of ${summary.fieldDays || 0} field days met the minimum`} tone={summary.averageAgentsPerFieldDay >= (summary.minimumAgentsPerDay || 0) ? 'blue' : 'amber'} />
      <Metric icon={ClipboardList} label="Field actions" value={`${summary.completedVisits || 0}`} detail={`${summary.fieldActions || 0} first-visit or transfer updates`} tone="navy" />
    </section>
    <section className="field-progress-grid">
      <article className="surface-card field-chart-card">
          <div className="field-section-heading"><div><span className="section-kicker">DAILY RHYTHM</span><h3>Unique agents reached each day</h3><p>Each agent can be visited once in a calendar month. The dotted line shows your three-month daily minimum.</p></div><span className="field-section-icon"><TrendingUp size={18} /></span></div>
        <div className="field-chart-content"><DailyChart data={summary.daily || []} target={summary.minimumAgentsPerDay || 0} /><div className="field-chart-note">Showing {summary.daysElapsed || 0} days in the selected period</div></div>
      </article>
      <div className="field-progress-aside">
        <CoachingCard summary={summary} focus={focus} />
        <article className="surface-card field-weekday-card">
          <div className="field-section-heading compact"><div><span className="section-kicker">WHEN YOUR ROUTES WORK</span><h3>Average by weekday</h3><p>{summary.strongestWeekday ? `${summary.strongestWeekday} is your strongest day so far.` : 'Complete a field day to reveal your strongest periods.'}</p></div><span className="field-section-icon"><CalendarDays size={17} /></span></div>
          <div className="field-chart-content"><WeekdayChart data={summary.weekdayAverages || []} target={summary.minimumAgentsPerDay || 0} /></div>
        </article>
      </div>
    </section>
    <section className="field-progress-grid field-progress-grid-bottom">
      <TerritoryExplorer role="TC" data={explorer} loading={explorerState.loading} error={explorerState.error} reload={explorerState.reload} openTerritory={openTerritory} selectPlanArea={selectPlanArea} navigate={navigate} />
      <PlanPanel month={planMonth} plans={plansState.plans} area={plansState.area} onSave={savePlan} onDelete={deletePlan} saving={plansState.saving} loading={plansState.loading} error={plansState.error} setError={plansState.setError} minimumAgentsPerDay={summary.minimumAgentsPerDay || 1} />
    </section>
  </div>;
}

function AdminView({ data, explorer, explorerState, periodLabel, openTerritory, navigate }) {
  const summary = data?.summary || {};
  const rankings = data?.rankings || [];
  const territories = [...(data?.territories || [])].sort((a, b) => a.coveragePercentage - b.coveragePercentage || b.remainingAgents - a.remainingAgents);
  const meanCoverage = rankings.length ? rankings.reduce((sum, entry) => sum + entry.coveragePercentage, 0) / rankings.length : 0;
  const bestTC = rankings.find((tc) => tc.assignedDistricts > 0 && tc.totalAgents > 0);
  const focus = data?.focusAreas?.[0];
  return <div className="field-performance-view">
    <section className="field-performance-banner admin">
      <div><span className="field-banner-eyebrow"><Activity size={14} /> FIELD OPERATIONS · {periodLabel}</span><h2>See progress across the field team</h2><p>Compare territory coverage, recognize strong routines, and spot where coordinators need support.</p></div>
    </section>
    <section className="field-progress-metrics" aria-label="Team field performance in the selected dates">
      <Metric icon={UsersRound} label="Agents reached" value={`${summary.visitedAgents || 0} / ${summary.totalAgents || 0}`} detail={`${percent(summary.coveragePercentage)} network coverage`} tone="orange" />
      <Metric icon={MapPinned} label="Completed visits" value={`${summary.completedVisits || 0}`} detail={`${summary.fieldDays || 0} active field days`} tone="green" />
      <Metric icon={Target} label="Minimum per field day" value={`${summary.minimumAgentsPerDay || 0}`} detail={`${summary.totalAgents || 0} active agents · cover in three months`} tone="green" />
      <Metric icon={Sparkles} label="Strongest coverage" value={bestTC?.name || '—'} detail={bestTC ? `${percent(bestTC.coveragePercentage)} across ${bestTC.assignedDistricts} districts` : 'No active TC records'} tone="blue" />
    </section>
    {focus && <article className="field-admin-insight"><span className="field-insight-icon"><LocateFixed size={17} /></span><div><strong>Where support can move coverage fastest</strong><p>{focus.territoryName} has {focus.remainingAgents} active agents still to reach and {percent(focus.coveragePercentage)} coverage in this period. Review the route plan with its assigned TC.</p></div><button type="button" className="text-link" onClick={() => openTerritory(focus.territoryId)}>Explore area <ArrowRight size={15} /></button></article>}
    <section className="field-progress-grid">
      <article className="surface-card field-leaderboard-card">
        <div className="field-section-heading"><div><span className="section-kicker">COORDINATOR COMPARISON</span><h3>TC performance</h3><p>Ranked by the share of active assigned agents reached during the selected period.</p></div><span className="field-section-icon"><UsersRound size={18} /></span></div>
        <div className="field-table-wrap"><table className="field-performance-table"><thead><tr><th>Rank · TC</th><th>Agent coverage</th><th>Avg / field day</th><th>Daily minimum</th><th>Visits</th></tr></thead><tbody>
          {rankings.map((tc, index) => <tr key={tc.tcId}>
            <td><span className={`field-rank ${index < 3 ? 'top' : ''}`}>{String(index + 1).padStart(2, '0')}</span><span className="field-tc-name"><strong>{tc.name}</strong><small>{tc.assignedDistricts} district{tc.assignedDistricts === 1 ? '' : 's'} · {tc.totalAgents} active agents</small></span></td>
            <td><div className="field-table-coverage"><strong>{percent(tc.coveragePercentage)}</strong><ProgressTrack value={tc.coveragePercentage} /><small>{tc.visitedAgents} reached · {tc.remainingAgents} remaining</small></div></td>
            <td>{tc.averageAgentsPerFieldDay} <small className="field-cell-subtext">agents</small></td>
            <td>{tc.minimumAgentsPerDay} <small className="field-cell-subtext">per weekday</small></td>
            <td>{tc.completedVisits}</td>
          </tr>)}
          {!rankings.length && <tr><td colSpan="5" className="field-table-empty">No active field coordinators were found.</td></tr>}
        </tbody></table></div>
        <div className="field-table-footnote"><span>Team average coverage</span><strong>{percent(meanCoverage)}</strong><span>Each TC is compared against their own assigned active-agent base.</span></div>
      </article>
      <article className="surface-card field-weekday-card admin-weekday-card">
        <div className="field-section-heading"><div><span className="section-kicker">TEAM ROUTINE</span><h3>Best performing weekdays</h3><p>{summary.strongestWeekday ? `${summary.strongestWeekday} has the strongest average so far.` : 'Daily activity will appear here as visits are completed.'}</p></div><span className="field-section-icon"><CalendarDays size={17} /></span></div>
        <div className="field-chart-content"><WeekdayChart data={summary.weekdayAverages || []} target={summary.minimumAgentsPerDay || 0} /></div>
        <div className="field-chart-note">Average distinct agents visited per calendar weekday across active coordinators.</div>
        <div className="field-team-activity"><span><Activity size={15} />Selected-period activity</span><strong>{summary.fieldActions || 0} field actions</strong><small>Includes first-visit location captures and transfer updates.</small></div>
      </article>
    </section>
    <section className="field-progress-grid field-progress-grid-bottom">
      <article className="surface-card field-territory-progress-card">
        <div className="field-section-heading"><div><span className="section-kicker">TERRITORY PROGRESS</span><h3>Districts to watch</h3><p>Low coverage appears first; open any district to drill down to agents.</p></div><span className="field-section-icon"><MapPin size={18} /></span></div>
        <div className="field-territory-progress-list">
          {territories.slice(0, 14).map((area) => <button type="button" className="field-territory-progress-row" key={area.territoryId} onClick={() => openTerritory(area.territoryId)}>
            <span><strong>{area.territoryName}</strong><small>{area.visitedAgents} reached · {area.remainingAgents} left · {area.visits} visits</small></span>
            <span><strong>{percent(area.coveragePercentage)}</strong><ProgressTrack value={area.coveragePercentage} /></span><ChevronRight size={16} />
          </button>)}
          {!territories.length && <div className="field-plan-empty">No active district coverage records are available.</div>}
        </div>
      </article>
      <TerritoryExplorer role="ADMIN" data={explorer} loading={explorerState.loading} error={explorerState.error} reload={explorerState.reload} openTerritory={openTerritory} navigate={navigate} />
    </section>
  </div>;
}

export default function FieldPerformance({ role: userRole, navigateTo, fromDate, toDate }) {
  const routerNavigate = useNavigate();
  const navigate = navigateTo || routerNavigate;
  const [planMonth] = useState(currentKigaliMonth);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [explorer, setExplorer] = useState(null);
  const [explorerLoading, setExplorerLoading] = useState(true);
  const [explorerError, setExplorerError] = useState('');
  const [territoryId, setTerritoryId] = useState('');
  const [plans, setPlans] = useState([]);
  const [planArea, setPlanArea] = useState(null);
  const [plansLoading, setPlansLoading] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [planError, setPlanError] = useState('');

  const loadPerformance = useCallback(async (signal) => {
    setLoading(true);
    setError('');
    try {
      const { data: response } = await api.get('/api/v1/reports/field-progress', { params: { fromDate, toDate }, signal });
      setData(response);
    } catch (err) {
      if (!signal?.aborted) setError(err.response?.data?.error || 'Could not load field progress for the selected dates.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [fromDate, toDate]);

  const loadExplorer = useCallback(async (signal) => {
    setExplorerLoading(true);
    setExplorerError('');
    try {
      const { data: response } = await api.get('/api/v1/reports/field-progress/explorer', { params: { fromDate, toDate, ...(territoryId ? { territoryId } : {}) }, signal });
      setExplorer(response);
    } catch (err) {
      if (!signal?.aborted) setExplorerError(err.response?.data?.error || 'Could not open this territory.');
    } finally {
      if (!signal?.aborted) setExplorerLoading(false);
    }
  }, [fromDate, toDate, territoryId]);

  const loadPlans = useCallback(async () => {
    if (userRole !== 'TC') return;
    setPlansLoading(true);
    setPlanError('');
    try {
      const { data: response } = await api.get('/api/v1/reports/field-progress/plans', { params: { month: planMonth } });
      setPlans(Array.isArray(response) ? response : []);
    } catch (err) {
      setPlanError(err.response?.data?.error || 'Could not load field plans.');
    } finally {
      setPlansLoading(false);
    }
  }, [planMonth, userRole]);

  useEffect(() => {
    const controller = new AbortController();
    loadPerformance(controller.signal);
    return () => controller.abort();
  }, [loadPerformance]);
  useEffect(() => {
    const controller = new AbortController();
    loadExplorer(controller.signal);
    return () => controller.abort();
  }, [loadExplorer]);
  useEffect(() => { loadPlans(); }, [loadPlans]);

  const openTerritory = useCallback((id) => setTerritoryId(id || ''), []);
  const selectPlanArea = useCallback((area) => {
    setPlanArea(area);
    setPlanError('');
  }, []);
  const savePlan = useCallback(async (payload) => {
    setPlanSaving(true);
    setPlanError('');
    try {
      await api.put('/api/v1/reports/field-progress/plans', payload);
      await loadPlans();
      return true;
    } catch (err) {
      setPlanError(err.response?.data?.error || 'Could not save this field plan.');
      return false;
    } finally {
      setPlanSaving(false);
    }
  }, [loadPlans]);
  const deletePlan = useCallback(async (id) => {
    setPlanError('');
    try {
      await api.delete(`/api/v1/reports/field-progress/plans/${id}`);
      await loadPlans();
    } catch (err) {
      setPlanError(err.response?.data?.error || 'Could not remove this field plan.');
    }
  }, [loadPlans]);

  const explorerState = useMemo(() => ({ loading: explorerLoading, error: explorerError, reload: loadExplorer }), [explorerLoading, explorerError, loadExplorer]);
  const visiblePlans = plans.filter((plan) => String(plan.planDate).slice(0, 7) === planMonth);
  const rangeKey = `${fromDate}:${toDate}`;
  const visibleExplorer = explorer?.rangeKey === rangeKey ? explorer : null;
  const periodLabel = fromDate && toDate ? `${reportDate(`${fromDate}T12:00:00`)} – ${reportDate(`${toDate}T12:00:00`)}` : 'selected dates';
  const plansState = useMemo(() => ({ plans: visiblePlans, loading: plansLoading, saving: planSaving, error: planError, area: planArea, setError: setPlanError }), [visiblePlans, plansLoading, planSaving, planError, planArea]);

  if (loading && data?.rangeKey !== rangeKey) return <div className="field-performance-view"><LoadingState type="cards" message="Building your field picture…" /></div>;
  if (error && data?.rangeKey !== rangeKey) return <div className="field-performance-view"><ErrorState message={error} onRetry={loadPerformance} /></div>;
  return <>
    {error && <div className="field-progress-global-error"><ErrorState message={error} onRetry={loadPerformance} /></div>}
    {userRole === 'TC'
      ? <TCView data={data} explorer={visibleExplorer} explorerState={explorerState} plansState={plansState} planMonth={planMonth} periodLabel={periodLabel} openTerritory={openTerritory} selectPlanArea={selectPlanArea} savePlan={savePlan} deletePlan={deletePlan} navigate={navigate} />
      : <AdminView data={data} explorer={visibleExplorer} explorerState={explorerState} periodLabel={periodLabel} openTerritory={openTerritory} navigate={navigate} />}
  </>;
}
