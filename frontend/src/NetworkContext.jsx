import React, { createContext, useContext, useMemo, useState } from 'react';

export const IREMBO_NETWORK = 'IREMBO';
export const MOOLA_PLUS_NETWORK = 'MOOLA_PLUS';
const STORAGE_KEY = 'ddin.selectedNetwork';
const NetworkContext = createContext(null);

function readSavedNetwork() {
  try {
    return localStorage.getItem(STORAGE_KEY) === MOOLA_PLUS_NETWORK ? MOOLA_PLUS_NETWORK : IREMBO_NETWORK;
  } catch {
    return IREMBO_NETWORK;
  }
}

export function NetworkProvider({ children }) {
  const [network, setNetworkState] = useState(readSavedNetwork);
  const setNetwork = (nextNetwork) => {
    const safeNetwork = nextNetwork === MOOLA_PLUS_NETWORK ? MOOLA_PLUS_NETWORK : IREMBO_NETWORK;
    setNetworkState(safeNetwork);
    try { localStorage.setItem(STORAGE_KEY, safeNetwork); } catch { /* storage may be disabled */ }
  };
  const value = useMemo(() => ({ network, setNetwork }), [network]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork() {
  const value = useContext(NetworkContext);
  if (!value) throw new Error('useNetwork must be used inside NetworkProvider');
  return value;
}
