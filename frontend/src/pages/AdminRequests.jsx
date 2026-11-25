import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import RequestNotifications from '../components/RequestNotifications';

export default function AdminRequests() {
  const { user } = useAuth();
  if (user?.role !== 'ADMIN') return <Navigate to="/dashboard" replace />;
  return <RequestNotifications role="ADMIN" mode="page" />;
}
