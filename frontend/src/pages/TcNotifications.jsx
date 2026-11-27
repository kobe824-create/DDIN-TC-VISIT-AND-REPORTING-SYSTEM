import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import RequestNotifications from '../components/RequestNotifications';

export default function TcNotifications() {
  const { user } = useAuth();
  if (user?.role !== 'TC') return <Navigate to="/dashboard" replace />;
  return <RequestNotifications role="TC" mode="page" />;
}
