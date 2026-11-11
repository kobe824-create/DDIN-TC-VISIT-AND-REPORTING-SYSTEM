import React from 'react';
import { ArrowRight, CircleHelp } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PageHeader from './PageHeader';
import { MOOLA_PLUS_NETWORK, useNetwork } from '../NetworkContext';

export default function NetworkNotice({ title, description }) {
  const { network } = useNetwork();
  const navigate = useNavigate();
  const isMoola = network === MOOLA_PLUS_NETWORK;
  return <div className="page network-notice-page">
    <PageHeader title={title} subtitle={description} />
    <section className="surface-card network-notice-card">
      <span><CircleHelp size={20} /></span>
      <div><strong>{isMoola ? 'This workflow belongs to Irembo' : 'This view belongs to Moola Plus'}</strong>
        <p>{isMoola
          ? 'Moola Plus agents are read from the DDIN registry. Visit records are only collected for Irembo agents in this tool.'
          : 'The selected page is designed for DDIN Moola Plus registry data. Select Moola Plus under Overview to see that network’s agents and activity.'}</p>
        <button type="button" className="btn btn-secondary" onClick={() => navigate(isMoola ? '/agents' : '/dashboard')}>{isMoola ? 'View Moola Plus agents' : 'Open selected overview'}<ArrowRight size={15} /></button>
      </div>
    </section>
  </div>;
}
