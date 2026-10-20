import React, { createContext, useState, useEffect, useContext } from 'react';
import api from './api';
import { clearAuthSession, saveAgentPack, saveAuthSession } from './offline/store';

async function prepareOfflineFieldData(userData, token, refreshToken) {
  if (userData?.role?.toUpperCase() !== 'TC') return;
  try {
    const { data } = await api.get('/api/v1/agents/offline-pack');
    await saveAgentPack(data);
  } catch {
    // Keep the last downloaded pack when the device is offline or the refresh fails.
  }
  try { await saveAuthSession({ userId: userData.id, accessToken: token, refreshToken }); } catch { /* Login still works if browser storage is unavailable. */ }
}

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    const savedUser = localStorage.getItem('user');
    if (!savedUser) return null;
    try { return JSON.parse(savedUser); } catch { localStorage.removeItem('user'); return null; }
  });

  const login = async (username, password) => {
    try {
      const response = await api.post('/api/v1/auth/login', { username, password });
      const { token, refreshToken, user: userData } = response.data;
      const normalizedUser = {
        ...userData,
        name: [userData.firstName, userData.lastName].filter(Boolean).join(' ') || userData.username,
      };
      localStorage.setItem('token', token);
      if (refreshToken) localStorage.setItem('refreshToken', refreshToken);
      localStorage.setItem('user', JSON.stringify(normalizedUser));
      void prepareOfflineFieldData(normalizedUser, token, refreshToken);
      setUser(normalizedUser);
      return { success: true, mustChangePassword: Boolean(normalizedUser.mustChangePassword) };
    } catch (error) {
      return { success: false, error: error.response?.data?.error || error.response?.data?.message || 'Login failed. Check your connection and try again.' };
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    void clearAuthSession().catch(() => {});
    setUser(null);
  };

  const completePasswordChange = ({ token, refreshToken } = {}) => {
    if (token) localStorage.setItem('token', token);
    if (refreshToken) localStorage.setItem('refreshToken', refreshToken);
    const updatedUser = { ...user, mustChangePassword: false, passwordResetExpiresAt: null };
    localStorage.setItem('user', JSON.stringify(updatedUser));
    if (updatedUser?.role?.toUpperCase() === 'TC') void saveAuthSession({ userId: updatedUser.id, accessToken: token, refreshToken }).catch(() => {});
    setUser(updatedUser);
  };

  useEffect(() => {
    if (user?.role?.toUpperCase() !== 'TC') return undefined;
    const refreshFieldPackage = () => prepareOfflineFieldData(user, localStorage.getItem('token'), localStorage.getItem('refreshToken'));
    if (navigator.onLine) refreshFieldPackage();
    window.addEventListener('online', refreshFieldPackage);
    return () => window.removeEventListener('online', refreshFieldPackage);
  }, [user?.id, user?.role]);

  const isAuthenticated = !!user;

  return (
    <AuthContext.Provider value={{ user, login, logout, completePasswordChange, isAuthenticated }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
