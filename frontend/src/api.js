import axios from 'axios';
import { saveAuthSession } from './offline/store';

let refreshPromise = null;

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '',
  headers: {
    'Content-Type': 'application/json'
  }
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status;
    const hasToken = Boolean(localStorage.getItem('token'));
    const expiredToken = status === 403 && error.response?.data?.error === 'Invalid or expired token';
    const originalRequest = error.config;
    const refreshToken = localStorage.getItem('refreshToken');

    if (hasToken && refreshToken && (status === 401 || expiredToken) && !originalRequest?._retry) {
      originalRequest._retry = true;
      try {
        if (!refreshPromise) {
          refreshPromise = axios.post(`${api.defaults.baseURL}/api/v1/auth/refresh`, { refreshToken }).finally(() => { refreshPromise = null; });
        }
        const response = await refreshPromise;
        localStorage.setItem('token', response.data.token);
        try {
          const user = JSON.parse(localStorage.getItem('user') || 'null');
          if (user?.role?.toUpperCase() === 'TC') await saveAuthSession({ userId: user.id, accessToken: response.data.token, refreshToken });
        } catch { /* The live API request can continue even if local offline storage is unavailable. */ }
        originalRequest.headers.Authorization = `Bearer ${response.data.token}`;
        return api(originalRequest);
      } catch {
        // Fall through and clear the expired session below.
      }
    }

    if (hasToken && (status === 401 || expiredToken)) {
      localStorage.removeItem('token');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
