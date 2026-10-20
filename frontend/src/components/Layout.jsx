import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronDown, FileBarChart2, FileClock, Upload,
  LayoutDashboard, LogOut, Map, MapPinned, Menu, Settings2, ShieldCheck,
  KeyRound, UserRound, UsersRound, X
} from 'lucide-react';
import { useAuth } from '../AuthContext';
import OfflineBanner from './OfflineBanner';
import { getVisitDrafts } from '../offline/store';
import { syncPendingVisits } from '../offline/sync';

const primaryNav = [
  { label: 'Overview', path: '/dashboard', icon: LayoutDashboard, roles: ['ADMIN', 'MANAGER', 'TC', 'CHAMPION'] },
  { label: 'Visits', path: '/visits', icon: MapPinned, roles: ['ADMIN', 'MANAGER', 'TC', 'CHAMPION'] },
  { label: 'Agents', path: '/agents', icon: UsersRound, roles: ['ADMIN', 'MANAGER', 'TC', 'CHAMPION'] },
  { label: 'Reports', path: '/reports', icon: FileBarChart2, roles: ['ADMIN', 'MANAGER', 'TC', 'CHAMPION'] },
];

const managementNav = [
  { label: 'Users & roles', path: '/users', icon: UserRound, roles: ['ADMIN', 'MANAGER'] },
  { label: 'Territories', path: '/territories', icon: Map, roles: ['ADMIN', 'MANAGER'] },
  { label: 'Bulk registration', path: '/bulk-import', icon: Upload, roles: ['ADMIN', 'TC'] },
];

const systemNav = [
  { label: 'Visit settings', path: '/config', icon: Settings2, roles: ['ADMIN'] },
  { label: 'Audit trail', path: '/audit-logs', icon: FileClock, roles: ['ADMIN'] },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const role = user?.role?.toUpperCase();
  const mustChangePassword = Boolean(user?.mustChangePassword);
  const changePasswordNav = [{ label: 'Change password', path: '/profile', icon: KeyRound, roles: [role] }];
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.name || user?.username || 'User';
  const initials = fullName.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  useEffect(() => {
    const onlineHandler = () => setOnline(true);
    const offlineHandler = () => setOnline(false);
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);
    return () => {
      window.removeEventListener('online', onlineHandler);
      window.removeEventListener('offline', offlineHandler);
    };
  }, []);

  useEffect(() => {
    let touchGesture = null;
    const onTouchStart = (event) => {
      if (!window.matchMedia('(max-width: 820px)').matches || event.touches.length !== 1) {
        touchGesture = null;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      touchGesture = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
        axis: null,
        insideTable: Boolean(target?.closest('.table-scroll')),
      };
    };
    const onTouchMove = (event) => {
      if (!touchGesture || touchGesture.insideTable || event.touches.length !== 1) return;
      const deltaX = event.touches[0].clientX - touchGesture.x;
      const deltaY = event.touches[0].clientY - touchGesture.y;
      if (!touchGesture.axis && Math.max(Math.abs(deltaX), Math.abs(deltaY)) > 8) {
        touchGesture.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
      }
      if (touchGesture.axis === 'horizontal') event.preventDefault();
    };
    const clearTouch = () => { touchGesture = null; };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', clearTouch, { passive: true });
    document.addEventListener('touchcancel', clearTouch, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', clearTouch);
      document.removeEventListener('touchcancel', clearTouch);
    };
  }, []);

  useEffect(() => {
    if (role !== 'TC' || !user?.id) { setPendingCount(0); return undefined; }
    let active = true;
    const refreshPending = async () => {
      try {
        const drafts = await getVisitDrafts(user.id);
        if (active) setPendingCount(drafts.filter((draft) => draft.completed).length);
      } catch { if (active) setPendingCount(0); }
    };
    const onQueueUpdate = () => { void refreshPending(); };
    const onWorkerMessage = (event) => { if (event.data?.type === 'DDIN_OFFLINE_QUEUE_UPDATED') void refreshPending(); };
    window.addEventListener('ddin-offline-queue-updated', onQueueUpdate);
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);
    void refreshPending();
    return () => {
      active = false;
      window.removeEventListener('ddin-offline-queue-updated', onQueueUpdate);
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage);
    };
  }, [role, user?.id]);

  useEffect(() => {
    if (role !== 'TC' || !user?.id || !online) return;
    let active = true;
    const syncOnReconnect = async () => {
      setSyncing(true);
      try { await syncPendingVisits(user.id); }
      finally {
        if (active) {
          const drafts = await getVisitDrafts(user.id).catch(() => []);
          setPendingCount(drafts.filter((draft) => draft.completed).length);
          setSyncing(false);
        }
      }
    };
    void syncOnReconnect();
    return () => { active = false; };
  }, [role, user?.id, online]);

  const syncNow = async () => {
    if (!user?.id || syncing) return;
    setSyncing(true);
    try { await syncPendingVisits(user.id); }
    finally {
      const drafts = await getVisitDrafts(user.id).catch(() => []);
      setPendingCount(drafts.filter((draft) => draft.completed).length);
      setSyncing(false);
    }
  };

  useEffect(() => {
    setDrawerOpen(false);
    setProfileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    const closeOnDesktopResize = () => {
      if (window.matchMedia('(min-width: 1201px)').matches) setDrawerOpen(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnDesktopResize);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnDesktopResize);
    };
  }, [drawerOpen]);

  const signOut = () => {
    logout();
    navigate('/login');
  };

  const renderGroup = (label, items) => {
    const visible = items.filter((item) => item.roles.includes(role));
    if (!visible.length) return null;
    return (
      <section className="nav-section" key={label}>
        <p className="nav-section-label">{label}</p>
        <div className="nav-items">
          {visible.map(({ label: itemLabel, path, icon: Icon }) => (
            <NavLink key={path} to={path} className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}>
              <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
              <span>{itemLabel}</span>
            </NavLink>
          ))}
        </div>
      </section>
    );
  };

  const Sidebar = () => (
    <div className="sidebar-inner">
      <div className="brand-lockup">
        <img className="brand-logo" src="/logo.png" alt="DDIN" />
        <div className="brand-copy"><strong>DDIN</strong><span>Digital Distribution<br />Inclusion Network</span></div>
      </div>

      <nav className="side-navigation" aria-label="Main navigation">
        {mustChangePassword ? renderGroup('Account security', changePasswordNav) : <>
          {renderGroup('Workspace', primaryNav)}
          {renderGroup('Management', managementNav)}
          {renderGroup('Administration', systemNav)}
        </>}
      </nav>

      <div className="sidebar-bottom">
        <div className="field-note">
          <div className="field-note-icon"><ShieldCheck size={16} /></div>
          <div><strong>Field integrity</strong><span>Visits are location verified</span></div>
        </div>
        <button className="sidebar-user" onClick={() => navigate('/profile')}>
          <span className="avatar avatar-dark">{initials}</span>
          <span className="sidebar-user-copy"><strong>{fullName}</strong><small>{role || 'USER'}</small></span>
          <ChevronDown size={15} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="app-shell">
      <aside className="desktop-sidebar"><Sidebar /></aside>
      {drawerOpen && <div className="mobile-drawer-wrap">
        <button className="drawer-scrim" aria-label="Close navigation" onClick={() => setDrawerOpen(false)} />
        <aside id="mobile-navigation" className="mobile-sidebar" aria-label="Main navigation">
          <button className="drawer-close" onClick={() => setDrawerOpen(false)} aria-label="Close menu"><X size={19} /></button>
          <Sidebar />
        </aside>
      </div>}

      <div className="app-main">
        {role === 'TC' && (!online || pendingCount > 0) && <OfflineBanner online={online} pendingCount={pendingCount} onSync={syncNow} syncing={syncing} />}
        <header className="topbar">
          <div className="topbar-heading">
            <button className="icon-button menu-toggle" onClick={() => setDrawerOpen(true)} aria-label="Open navigation" aria-expanded={drawerOpen} aria-controls="mobile-navigation"><Menu size={20} /></button>
            <div className="topbar-brand-lockup">
              <img src="/logo.png" alt="" />
              <span><strong>DDIN</strong><small>TC visit system</small></span>
            </div>
          </div>
          <div className="topbar-actions">
            <div className="profile-menu-wrap">
              <button className="topbar-profile" onClick={() => setProfileOpen((value) => !value)} aria-expanded={profileOpen}>
                <span className="avatar">{initials}</span><span className="topbar-profile-copy"><strong>{fullName}</strong><small>{role}</small></span><ChevronDown size={15} />
              </button>
              {profileOpen && <>
                <button className="menu-dismiss" aria-label="Close account menu" onClick={() => setProfileOpen(false)} />
                <div className="account-menu">
                  <button onClick={() => navigate('/profile')}><UserRound size={16} />My profile</button>
                  <button onClick={signOut} className="signout-item"><LogOut size={16} />Sign out</button>
                </div>
              </>}
            </div>
          </div>
        </header>
        <main className={`page-canvas${location.pathname === '/visits/new' ? ' visit-workflow-canvas' : ''}`}><Outlet /></main>
      </div>
      <nav className={`mobile-tabs${mustChangePassword ? ' mobile-tabs-single' : ''}`} aria-label="Quick navigation">
        {mustChangePassword ? <NavLink to="/profile" className={({ isActive }) => `mobile-tab${isActive ? ' is-active' : ''}`}><KeyRound size={19} /><span>Change password</span></NavLink> : <>
          {primaryNav.map(({ label, path, icon: Icon }) => <NavLink key={path} to={path} className={({ isActive }) => `mobile-tab${isActive ? ' is-active' : ''}`}><Icon size={19} /><span>{label}</span></NavLink>)}
        </>}
      </nav>
    </div>
  );
}
