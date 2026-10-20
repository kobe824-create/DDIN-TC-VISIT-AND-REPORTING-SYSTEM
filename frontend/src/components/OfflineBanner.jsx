import React from 'react';
import { RefreshCw, Wifi, WifiOff } from 'lucide-react';

const OfflineBanner = ({ online = false, pendingCount = 0, onSync, syncing = false }) => {
  return (
    <div className={`offline-banner ${online ? 'is-online' : ''}`} role="status">
      <div className="offline-banner-copy">
        {online ? <Wifi size={16} aria-hidden="true" /> : <WifiOff size={16} aria-hidden="true" />}
        <span className="font-medium">{online ? 'Connection restored' : "You're offline"}</span>
        <span>{online
          ? (pendingCount ? `${pendingCount} completed ${pendingCount === 1 ? 'visit is' : 'visits are'} saved on this device.` : 'Your downloaded agent list and completed visit forms remain available.')
          : `Offline visits can be recorded with your downloaded agent package.${pendingCount ? ` ${pendingCount} completed ${pendingCount === 1 ? 'visit is' : 'visits are'} waiting to sync.` : ''}`}</span>
      </div>
      {online && pendingCount > 0 && <button type="button" onClick={onSync} disabled={syncing} className="offline-sync-button"><RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />{syncing ? 'Syncing…' : 'Sync visits'}</button>}
    </div>
  );
};

export default OfflineBanner;
