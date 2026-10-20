import React from 'react';
import { Inbox } from 'lucide-react';

const EmptyState = ({ icon: Icon = Inbox, title = 'No data', message, action, actionLabel }) => {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div className="p-3 rounded-full bg-gray-100 mb-4">
        <Icon size={28} className="text-gray-400" />
      </div>
      <h3 className="text-sm font-medium text-gray-900 mb-1">{title}</h3>
      {message && <p className="text-small text-gray-500 max-w-sm">{message}</p>}
      {action && (
        <button onClick={action} className="btn-primary btn-sm mt-4">
          {actionLabel || 'Get started'}
        </button>
      )}
    </div>
  );
};

export default EmptyState;
