import React, { useEffect, useLayoutEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, WifiOff } from 'lucide-react';
import { useAuth } from '../AuthContext';

export default function LoginPage() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const { login } = useAuth();
  const navigate = useNavigate();

  useLayoutEffect(() => {
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (!themeColor) return undefined;
    const previousColor = themeColor.content;
    themeColor.content = '#f5f7fb';
    return () => { themeColor.content = previousColor; };
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);

  const submit = async (event) => {
    event.preventDefault(); setError(''); setLoading(true);
    const result = await login(identifier, password);
    if (result.success) navigate(result.mustChangePassword ? '/profile' : '/dashboard', { replace: true });
    else setError(result.error);
    setLoading(false);
  };

  return <main className="login-screen">
    <section className="login-story-panel" aria-label="DDIN visit reporting">
      <div className="login-story-brand">
        <img src="/logo.png" alt="DDIN logo" />
        <span><strong>DDIN</strong><small>Digital Distribution Inclusion Network</small></span>
      </div>
      <div className="login-story-copy">
        <p className="login-overline">DDIN TC VISIT SYSTEM</p>
        <h1>Territory visit reporting</h1>
        <p>Check in with agents, document each visit, and keep follow-up details together.</p>
      </div>
      <footer className="login-story-foot">DDIN · TC visit and reporting</footer>
    </section>
    <section className="login-form-panel"><div className="login-form-wrap">
      <h1>Sign in</h1><p className="login-intro">Use your DDIN account to continue.</p>
      {!online && <div className="login-offline"><WifiOff size={16} /><span>You’re offline. Connect to the internet to sign in.</span></div>}
      {error && <div className="login-error" role="alert">{error}</div>}
      <form onSubmit={submit} className="login-form"><label htmlFor="login-identifier">Username or email</label><input id="login-identifier" autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="Enter your username or email" required />
        <div className="password-label-row"><label htmlFor="login-password">Password</label><Link to="/forgot-password">Need help signing in?</Link></div><div className="login-password-field"><input id="login-password" autoComplete="current-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" required /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
        <button className="login-submit" type="submit" disabled={loading || !online}>{loading ? 'Signing in…' : 'Sign in'}</button>
      </form><footer>© {new Date().getFullYear()} DDIN. All rights reserved.</footer></div></section>
  </main>;
}
