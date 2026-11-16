import React from 'react';
import { Activity, Banknote, UsersRound } from 'lucide-react';

const statusOrder = [
  { key: 'Active', range: 'Transaction in the last 3 months' },
  { key: 'Dormant', range: 'Past transaction, none in 3 months' },
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
    <p className="moola-data-note">Active means at least one transaction in the last 3 months. Dormant means the agent has transacted before but not during that period. Inactive means no transactions are reported. Agents without a transaction date are shown as Dormant until recent activity can be confirmed.</p>
  </div>;
}
