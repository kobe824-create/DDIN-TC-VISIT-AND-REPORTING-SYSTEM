import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

export default function ForgotPassword() {
  return <main className="login-screen"><section className="login-form-panel"><div className="login-form-wrap recovery-wrap"><div className="login-brand"><img src="/logo.png" alt="DDIN logo" /><span><strong>Digital Distribution Inclusion Network</strong><small>TC visit and reporting system</small></span></div><h1>Password reset</h1><p className="login-intro">Password recovery is managed by your DDIN administrator. Contact your supervisor or system administrator to reset your account credentials.</p><div className="recovery-security"><ShieldCheck size={16} /><span>For your security, password reset links are not sent by this system.</span></div><Link className="back-to-login" to="/login"><ArrowLeft size={15} />Back to sign in</Link><footer>© {new Date().getFullYear()} DDIN. All rights reserved.</footer></div></section></main>;
}
