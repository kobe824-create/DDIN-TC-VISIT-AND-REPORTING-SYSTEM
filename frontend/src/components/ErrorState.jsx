import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

const ErrorState = ({ message = 'Something went wrong', onRetry, className = '' }) => {
  return (
    <div className={`flex flex-col items-center justify-center py-12 px-4 text-center ${className}`}>
      <div className="p-3 rounded-full bg-status-error-bg mb-4">
        <AlertTriangle size={24} className="text-status-error" />
      </div>
      <p className="text-sm text-gray-700 mb-1">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary btn-sm mt-3">
          <RefreshCw size={14} />
          Try again
        </button>
      )}
    </div>
  );
};

export default ErrorState;
