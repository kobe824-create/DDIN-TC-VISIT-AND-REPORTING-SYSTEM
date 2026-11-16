export const ISSUE_STATUSES = ['NEW', 'IN_PROGRESS', 'WAITING', 'ESCALATED', 'RESOLVED', 'REJECTED', 'CLOSED'];
export const ISSUE_STATUS = {
  NEW: { label: 'New', tone: 'blue' },
  IN_PROGRESS: { label: 'Working on it', tone: 'amber' },
  WAITING: { label: 'Waiting for information', tone: 'orange' },
  ESCALATED: { label: 'Escalated', tone: 'orange' },
  RESOLVED: { label: 'Resolved', tone: 'green' },
  REJECTED: { label: 'Rejected', tone: 'red' },
  CLOSED: { label: 'Closed', tone: 'gray' },
};
export const ISSUE_CATEGORIES = [
  ['REQUEST', 'Request from agent'],
  ['MATERIALS', 'Materials'],
  ['PAYMENT', 'Payment or commission'],
  ['DEVICE', 'Phone or device'],
  ['ACCOUNT', 'Account, PIN or login'],
  ['TRAINING', 'Training'],
  ['COMPLAINT', 'Complaint'],
  ['OTHER', 'Other'],
];
export const ISSUE_PRIORITIES = [
  ['LOW', 'Low'],
  ['NORMAL', 'Normal'],
  ['HIGH', 'High'],
  ['URGENT', 'Urgent'],
];
export const ISSUE_NETWORKS = [
  ['IREMBO', 'Irembo'],
  ['MOOLA_PLUS', 'Moola Plus'],
  ['COMBINED', 'Other / both'],
];
export const categoryLabel = (value) => ISSUE_CATEGORIES.find(([key]) => key === value)?.[1] || value || 'Other';
export const priorityLabel = (value) => ISSUE_PRIORITIES.find(([key]) => key === value)?.[1] || value || 'Normal';
export const personName = (person) => [person?.firstName, person?.lastName].filter(Boolean).join(' ') || person?.username || '—';
export const issueDate = (value) => value ? new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Kigali', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(new Date(value)) : '—';
export const isIssueOpen = (status) => ['NEW', 'IN_PROGRESS', 'WAITING', 'ESCALATED'].includes(status);
