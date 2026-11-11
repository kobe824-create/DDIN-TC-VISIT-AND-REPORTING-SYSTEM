import React from 'react';
import { Activity, Banknote, UsersRound } from 'lucide-react';

const statusOrder = [
  { key: 'Active', range: '80+ reported transactions' },
  { key: 'Transacting', range: '30–79 reported transactions' },
  { key: 'Dormant', range: '1–29 reported transactions' },
  { key: 'Inactive', range: 'No reported transactions' },
];
const number = (value) => Number(value || 0).toLocaleString();

function Metric({ icon: Icon, label, value, detail }) {
  return <article className="moola-metric-card"><span className="moola-metric-icon"><Icon size={18} /></span><span><small>{label}</small><strong>{value}</strong><em>{detail}</em></span></article>;
}

export default function MoolaAnalytics({ summary, selectedStatus = '', onStatusSelect = () => {} }) {
  const byStatus = summary?.byStatus || {};
  const depositRate = summary?.totalAgents ? Math.round(Number(summary.depositingAgents || 0) / summary.totalAgents * 100) : 0;
  return <div className="moola-analytics">
    <section className="moola-metrics-grid" aria-label="Moola Plus summary">
      <Metric icon={UsersRound} label="Total agents" value={number(summary?.totalAgents)} detail="In your authorized coverage" />
      <Metric icon={Activity} label="Reported transactions" value={number(summary?.reportedDepositCount)} detail="DDIN manual deposit count" />
      <Metric icon={Banknote} label="Agents with transactions" value={`${number(summary?.depositingAgents)} · ${depositRate}%`} detail={`${number(summary?.agentsWithoutDeposits)} with none reported`} />
      {summary?.totalDeposited != null
        ? <Metric icon={Banknote} label="Total deposited" value={`${number(summary.totalDeposited)} RWF`} detail={summary?.floatBalance != null ? `Float balance ${number(summary.floatBalance)} RWF` : 'From DDIN deposit report'} />
        : <Metric icon={Activity} label="Inactive agents" value={number(byStatus.Inactive)} detail="No reported deposits" />}
    </section>
    <section className="moola-status-grid" aria-label="Agent activity status filters">
      {statusOrder.map(({ key, range }) => <button type="button" className={`moola-status-card${selectedStatus === key ? ' is-selected' : ''}`} aria-pressed={selectedStatus === key} key={key} onClick={() => onStatusSelect(selectedStatus === key ? '' : key)}>
        <span>{key}</span><strong>{number(byStatus[key])}</strong><small>{range}</small>
      </button>)}
    </section>
    <p className="moola-data-note">Activity is based on DDIN’s reported manual deposit count. Where the report includes deposit dates, the selected range recalculates each agent’s activity; otherwise the range uses the registration date.</p>
  </div>;
}
