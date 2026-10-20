import React, { useEffect } from 'react';
import { X, AlertTriangle } from 'lucide-react';

const ConfirmDialog = ({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', confirmVariant = 'danger', loading = false }) => {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  const confirmClass = confirmVariant === 'danger' ? 'btn-danger' : 'btn-primary';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-gray-900/50 animate-fade-in" onClick={onClose}></div>
      <div className="relative bg-white rounded-lg shadow-modal max-w-sm w-full animate-slide-up">
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 p-2 rounded-full bg-status-error-bg">
              <AlertTriangle size={18} className="text-status-error" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
              <p className="mt-1 text-sm text-gray-600">{message}</p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 bg-gray-50 rounded-b-lg border-t border-gray-200">
          <button onClick={onClose} className="btn-secondary btn-sm" disabled={loading}>Cancel</button>
          <button onClick={onConfirm} className={`${confirmClass} btn-sm`} disabled={loading}>
            {loading ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
