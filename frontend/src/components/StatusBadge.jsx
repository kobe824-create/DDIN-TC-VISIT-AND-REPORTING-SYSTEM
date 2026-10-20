import React from 'react';
import { CheckCircle, AlertTriangle, XCircle, Clock, Circle, Wifi, WifiOff, MapPin, Eye } from 'lucide-react';

const statusConfig = {
  // Visit statuses
  completed:   { label: 'Completed', className: 'badge-success', icon: CheckCircle },
  started:     { label: 'Started', className: 'badge-info', icon: Circle },
  flagged:     { label: 'Flagged', className: 'badge-warning', icon: AlertTriangle },
  rejected:    { label: 'Rejected', className: 'badge-error', icon: XCircle },
  pending:     { label: 'Pending', className: 'badge-neutral', icon: Clock },

  // Location statuses
  verified:       { label: 'Verified', className: 'badge-success', icon: CheckCircle },
  outside_radius: { label: 'Outside Radius', className: 'badge-error', icon: XCircle },
  low_accuracy:   { label: 'Low Accuracy', className: 'badge-warning', icon: AlertTriangle },

  // Agent statuses
  active:    { label: 'Active', className: 'badge-success', icon: CheckCircle },
  inactive:  { label: 'Inactive', className: 'badge-neutral', icon: Circle },
  suspended: { label: 'Suspended', className: 'badge-error', icon: XCircle },

  // Sync statuses
  synced:  { label: 'Synced', className: 'badge-success', icon: Wifi },
  offline: { label: 'Offline', className: 'badge-warning', icon: WifiOff },

  // User roles
  admin:    { label: 'Admin', className: 'bg-brand-navy-100 text-brand-navy-900 badge' },
  manager:  { label: 'Manager', className: 'bg-brand-navy-100 text-brand-navy-700 badge' },
  tc:       { label: 'TC', className: 'bg-brand-orange-100 text-brand-orange-700 badge' },
  champion: { label: 'Champion', className: 'bg-teal-100 text-teal-700 badge' },
  agent:    { label: 'Agent', className: 'badge-neutral' },

  // Operational statuses
  operational:        { label: 'Operational', className: 'badge-success', icon: CheckCircle },
  temporarily_closed: { label: 'Temp. Closed', className: 'badge-warning', icon: Clock },
  permanently_closed: { label: 'Closed', className: 'badge-error', icon: XCircle },
};

const StatusBadge = ({ status, size = 'default', showIcon = true }) => {
  const key = (status || '').toLowerCase().replace(/\s+/g, '_');
  const config = statusConfig[key] || { label: status, className: 'badge-neutral' };
  const Icon = config.icon;
  const sizeClass = size === 'sm' ? 'text-[10px] px-1.5 py-0' : '';

  return (
    <span className={`${config.className} ${sizeClass}`}>
      {showIcon && Icon && <Icon size={size === 'sm' ? 10 : 12} className="mr-1 flex-shrink-0" />}
      {config.label}
    </span>
  );
};

export default StatusBadge;
