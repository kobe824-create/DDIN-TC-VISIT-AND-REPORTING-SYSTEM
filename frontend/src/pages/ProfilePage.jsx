import React, { useState } from 'react';
import { KeyRound, LockKeyhole, MapPin, ShieldCheck, UserRound } from 'lucide-react';
import { useAuth } from '../AuthContext';
import api from '../api';
import PageHeader from '../components/PageHeader';
import FormField from '../components/FormField';
import StatusBadge from '../components/StatusBadge';

export default function ProfilePage() {
  const { user, completePasswordChange } = useAuth();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.name || user?.username;
  const initials = (name || 'U').split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();

  const changePassword = async (event) => {
    event.preventDefault(); setError(''); setNotice('');
    if (form.newPassword.length < 8) { setError('Use at least 8 characters for your new password.'); return; }
    if (form.newPassword !== form.confirmPassword) { setError('The new passwords do not match.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/api/v1/auth/change-password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
      completePasswordChange(data);
      setNotice(data.message || 'Password updated successfully.'); setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err) { setError(err.response?.data?.error || 'Could not update your password.'); }
    finally { setSaving(false); }
  };

  return <div className="profile-page page"><PageHeader title={user?.mustChangePassword ? 'Secure your account' : 'My profile'} subtitle={user?.mustChangePassword ? 'Set a new password before continuing to field operations.' : 'Your DDIN account details and sign-in security.'} />
    <section className="profile-grid"><article className="surface-card profile-card"><div className="profile-identity"><span className="profile-avatar">{initials}</span><div><span className="section-kicker">ACCOUNT PROFILE</span><h2>{name}</h2><StatusBadge status={user?.role} /></div></div><div className="profile-details"><div><span><UserRound size={14} />Username</span><strong>{user?.username || '—'}</strong></div><div><span>EMAIL</span><strong>{user?.email || '—'}</strong></div><div><span>PHONE</span><strong>{user?.phoneNumber || '—'}</strong></div><div><span>ROLE</span><strong>{user?.role || '—'}</strong></div></div>{user?.assignedTerritories?.length > 0 && <div className="profile-territories"><span className="profile-territory-title"><MapPin size={14} />Assigned districts</span><div>{user.assignedTerritories.map((territory) => <span key={territory.id}>{territory.name}</span>)}</div></div>}</article>
      <article className="surface-card password-card"><div className="form-section-heading"><span className="detail-icon report-icon">{user?.mustChangePassword ? <KeyRound size={17} /> : <LockKeyhole size={17} />}</span><div><h2>{user?.mustChangePassword ? 'Choose a new password' : 'Change password'}</h2><p>{user?.mustChangePassword ? 'Enter the temporary password provided by your administrator, then choose a private password.' : 'Use a unique password with at least eight characters.'}</p></div></div>{user?.mustChangePassword && <div className="alert alert-info">Your administrator reset this account. Your temporary password expires {user.passwordResetExpiresAt ? new Date(user.passwordResetExpiresAt).toLocaleString() : 'soon'}.</div>}{error && <div className="alert alert-error">{error}</div>}{notice && <div className="alert alert-success">{notice}</div>}<form onSubmit={changePassword} className="password-form"><FormField.Input label={user?.mustChangePassword ? 'Temporary password' : 'Current password'} type="password" autoComplete="current-password" value={form.currentPassword} onChange={(event) => setForm({ ...form, currentPassword: event.target.value })} required /><FormField.Input label="New password" type="password" autoComplete="new-password" minLength={8} value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} required /><FormField.Input label="Confirm new password" type="password" autoComplete="new-password" minLength={8} value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} required /><button className="btn btn-primary" type="submit" disabled={saving}><ShieldCheck size={15} />{saving ? 'Updating…' : user?.mustChangePassword ? 'Set new password' : 'Update password'}</button></form></article></section>
  </div>;
}
