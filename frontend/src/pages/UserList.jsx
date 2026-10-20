import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Copy, KeyRound, Plus, Search, ShieldCheck, UsersRound, X } from 'lucide-react';
import { useAuth } from '../AuthContext';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ConfirmDialog, ErrorState, ListPagination, LoadingState, StatusBadge } from '../components';

export default function UserList() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [resetTarget, setResetTarget] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [issuedCredential, setIssuedCredential] = useState(null);
  const [copyStatus, setCopyStatus] = useState('');
  const isAdmin = user?.role === 'ADMIN';

  const loadUsers = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = { page, limit: pageSize };
      if (role) params.role = role;
      if (search.trim()) params.search = search.trim();
      const { data } = await api.get('/api/v1/users', { params });
      setUsers(data.data || []);
      setTotal(data.total ?? data.data?.length ?? 0);
      setPages(data.pages ?? 0);
      setPage(data.page ?? page);
    } catch (err) { setError(err.response?.data?.error || 'Could not load user accounts.'); }
    finally { setLoading(false); }
  }, [page, pageSize, role, search]);

  useEffect(() => {
    const timer = window.setTimeout(loadUsers, search.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [loadUsers, search]);
  useEffect(() => {
    const lastPage = Math.max(pages, 1);
    if (page > lastPage) setPage(lastPage);
  }, [page, pages]);

  const toggleStatus = async (item) => {
    try { await api.patch(`/api/v1/users/${item.id}/status`, { isActive: !item.isActive }); loadUsers(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update this account.'); }
  };

  const resetPassword = async () => {
    if (!resetTarget) return;
    setResetting(true); setError('');
    try {
      const { data } = await api.post(`/api/v1/users/${resetTarget.id}/reset-password`);
      setIssuedCredential(data);
      setResetTarget(null);
      setCopyStatus('');
      await loadUsers();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reset this account password.');
      setResetTarget(null);
    } finally { setResetting(false); }
  };

  const closeCredential = () => {
    setIssuedCredential(null);
    setCopyStatus('');
  };

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(issuedCredential.temporaryPassword);
      setCopyStatus('Copied to clipboard');
    } catch {
      setCopyStatus('Select the password above and copy it manually.');
    }
  };

  return <div className="user-list-page page">
    <PageHeader title="Users & roles" subtitle="Account access for coordinators, champions and management." actions={isAdmin && <button className="btn btn-primary" onClick={() => navigate('/users/new')}><Plus size={16} />Create account</button>} />
    <section className="agent-filter-bar surface-card"><label className="visit-search"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search name, username or email" /></label><select className="input agent-status-select" value={role} onChange={(event) => { setRole(event.target.value); setPage(1); }}><option value="">All roles</option>{['ADMIN', 'MANAGER', 'TC', 'CHAMPION', 'AGENT'].map((value) => <option value={value} key={value}>{value}</option>)}</select><span className="agent-result-count">{total.toLocaleString()} accounts</span></section>
    {error && <ErrorState message={error} onRetry={() => loadUsers()} />}
    {loading ? <LoadingState message="Loading accounts…" /> : !error && <section className="surface-card user-table-card">{users.length ? <div className="table-scroll"><table className="data-table user-table"><thead><tr><th>Account</th><th>Role</th><th>Contact</th><th>Created</th><th>Status</th>{isAdmin && <th>Manage</th>}</tr></thead><tbody>{users.map((item) => <tr key={item.id} onClick={() => isAdmin && navigate(`/users/${item.id}/edit`)}><td><div className="table-person"><span className="table-avatar"><UsersRound size={14} /></span><span><strong>{item.firstName} {item.lastName}</strong><small>@{item.username}</small></span></div></td><td><StatusBadge status={item.role} />{item.mustChangePassword && <small className="account-reset-flag">Password reset required</small>}</td><td>{item.email}</td><td>{new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(item.createdAt))}</td><td><span className={`location-result ${item.isActive ? 'verified' : 'needs-review'}`}><span />{item.isActive ? 'Active' : 'Inactive'}</span></td>{isAdmin && <td><div className="user-row-actions"><button className="btn btn-secondary btn-sm" onClick={(event) => { event.stopPropagation(); toggleStatus(item); }}>{item.isActive ? 'Deactivate' : 'Activate'}</button>{item.role === 'TC' && <button className="btn btn-secondary btn-sm" onClick={(event) => { event.stopPropagation(); setResetTarget(item); }}><KeyRound size={14} />Reset password</button>}</div></td>}</tr>)}</tbody></table></div> : <div className="table-empty"><div className="empty-mark"><ShieldCheck size={20} /></div><strong>No matching accounts</strong><span>Adjust the search or role filter.</span></div>}<ListPagination page={page} pages={pages} total={total} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} /><div className="card-footnote"><ShieldCheck size={14} /><span>Role based permissions are enforced by each service, in addition to the frontend.</span></div></section>}

    <ConfirmDialog
      open={Boolean(resetTarget)}
      onClose={() => !resetting && setResetTarget(null)}
      onConfirm={resetPassword}
      title="Reset TC password?"
      message={resetTarget ? `A temporary password will be generated for ${resetTarget.firstName} ${resetTarget.lastName}. Their current sessions will end, and they must choose a new password within 24 hours.` : ''}
      confirmLabel="Reset password"
      confirmVariant="primary"
      loading={resetting}
    />

    {issuedCredential && <div className="credential-modal-backdrop" onClick={closeCredential}>
      <section className="credential-modal" role="dialog" aria-modal="true" aria-labelledby="credential-title" onClick={(event) => event.stopPropagation()}>
        <button className="credential-modal-close" type="button" aria-label="Close" onClick={closeCredential}><X size={19} /></button>
        <span className="credential-icon"><KeyRound size={20} /></span>
        <span className="section-kicker">ONE TIME PASSWORD</span>
        <h2 id="credential-title">Share securely with {issuedCredential.user.username}</h2>
        <p>This password is shown once. The TC must change it after signing in. It expires {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(issuedCredential.expiresAt))}.</p>
        <label className="credential-password-label" htmlFor="temporary-password">Temporary password</label>
        <input id="temporary-password" className="input credential-password" value={issuedCredential.temporaryPassword} readOnly onFocus={(event) => event.target.select()} />
        <button className="btn btn-primary credential-copy-button" type="button" onClick={copyPassword}>{copyStatus === 'Copied to clipboard' ? <Check size={16} /> : <Copy size={16} />}{copyStatus === 'Copied to clipboard' ? 'Copied' : 'Copy password'}</button>
        {copyStatus && copyStatus !== 'Copied to clipboard' && <span className="credential-copy-note" role="status">{copyStatus}</span>}
        <button className="credential-done" type="button" onClick={closeCredential}>Done</button>
      </section>
    </div>}
  </div>;
}
