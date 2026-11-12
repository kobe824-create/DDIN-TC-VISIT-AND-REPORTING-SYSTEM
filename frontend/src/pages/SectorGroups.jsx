import React, { useCallback, useEffect, useState } from 'react';
import { Copy, ExternalLink, MessageCircle, RefreshCw, UsersRound } from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, LoadingState } from '../components';
import { MOOLA_PLUS_NETWORK, useNetwork } from '../NetworkContext';

const phoneDigits = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return /^0\d{9}$/.test(digits) ? `250${digits.slice(1)}` : digits;
};

export default function SectorGroups() {
  const { network } = useNetwork();
  const isMoolaPlus = network === MOOLA_PLUS_NETWORK;
  const groupsEndpoint = isMoolaPlus ? '/api/v1/agents/moola-plus-sector-groups' : '/api/v1/agents/sector-groups';
  const [sectors, setSectors] = useState([]);
  const [links, setLinks] = useState({});
  const [loading, setLoading] = useState(true);
  const [savingSector, setSavingSector] = useState('');
  const [processingSector, setProcessingSector] = useState('');
  const [consents, setConsents] = useState({});
  const [inviteConsents, setInviteConsents] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadSectors = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(groupsEndpoint);
      setSectors(Array.isArray(data) ? data : []);
      setLinks(Object.fromEntries((Array.isArray(data) ? data : []).map((sector) => [sector.id, sector.inviteUrl || ''])));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load your assigned sectors.');
    } finally { setLoading(false); }
  }, [groupsEndpoint]);

  useEffect(() => { loadSectors(); }, [loadSectors]);

  const saveLink = async (sector) => {
    setSavingSector(sector.id);
    setError(''); setNotice('');
    try {
      const { data } = await api.put(`${groupsEndpoint}/${sector.id}`, {
        inviteUrl: links[sector.id],
        confirmInviteConsent: inviteConsents[sector.id] === true,
      });
      setLinks((current) => ({ ...current, [sector.id]: data.inviteUrl }));
      setInviteConsents((current) => ({ ...current, [sector.id]: false }));
      const delivery = data.inviteDelivery;
      if (!delivery) setNotice(`Saved invite link removed for ${sector.name}.`);
      else if (delivery.status === 'provider_unavailable') setNotice(`Invite link saved for ${sector.name}, but WhatsApp invitations were not sent because the WhatsApp provider is not configured.`);
      else if (delivery.status === 'provider_error') setNotice(`Invite link saved for ${sector.name}, but WhatsApp could not verify the numbers. Retry saving the link after checking the provider connection.`);
      else setNotice(`Invite link saved for ${sector.name}. The current report shows ${delivery.sentCount} invitation${delivery.sentCount === 1 ? '' : 's'} sent and ${delivery.notWhatsAppCount} number${delivery.notWhatsAppCount === 1 ? ' is' : 's are'} not registered on WhatsApp. Check the follow-up list below.`);
      await loadSectors();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save this WhatsApp invite.');
    } finally { setSavingSector(''); }
  };

  const removeLink = async (sector) => {
    setSavingSector(sector.id);
    setError(''); setNotice('');
    try {
      await api.put(`${groupsEndpoint}/${sector.id}`, { inviteUrl: '' });
      setLinks((current) => ({ ...current, [sector.id]: '' }));
      setNotice(`Saved invite link removed for ${sector.name}.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove this saved invite link.');
    } finally { setSavingSector(''); }
  };

  const createOrUpdateGroup = async (sector) => {
    setProcessingSector(sector.id);
    setError(''); setNotice('');
    try {
      const { data } = await api.post(`${groupsEndpoint}/${sector.id}/create`, { confirmAgentConsent: consents[sector.id] === true });
      if (data.inviteUrl) setLinks((current) => ({ ...current, [sector.id]: data.inviteUrl }));
      const counts = `Added ${data.addedCount} of ${data.attemptedCount} phone number${data.attemptedCount === 1 ? '' : 's'}.`;
      const skipped = data.missingPhoneCount || data.invalidPhoneCount || data.failedCount
        ? ` ${data.missingPhoneCount || 0} missing, ${data.invalidPhoneCount || 0} invalid, and ${data.failedCount || 0} not added.` : '';
      setNotice(`${data.message} ${counts}${skipped}`);
      setConsents((current) => ({ ...current, [sector.id]: false }));
      await loadSectors();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create or update this WhatsApp group.');
    } finally { setProcessingSector(''); }
  };

  const copyLink = async (sector) => {
    try {
      await navigator.clipboard.writeText(links[sector.id] || '');
      setNotice(`Invite link copied for ${sector.name}.`);
    } catch { setError('Clipboard access is unavailable. Select and copy the invite link manually.'); }
  };

  const openGroupSetup = async (sector) => {
    const groupName = `DDIN ${sector.name}`;
    window.open('https://web.whatsapp.com/', '_blank', 'noopener,noreferrer');
    try {
      await navigator.clipboard.writeText(groupName);
      setNotice(`“${groupName}” copied. Create the group in WhatsApp, then paste its invite link above.`);
    } catch {
      setNotice(`Create “${groupName}” in WhatsApp, then paste the group invite link above.`);
    }
  };

  const inviteMessage = (sector) => `Hello, this is your TC. Join the ${sector.name} agent WhatsApp group using this invite link: ${links[sector.id]}`;
  const inviteHref = (sector, phone) => `https://wa.me/${phoneDigits(phone)}?text=${encodeURIComponent(inviteMessage(sector))}`;

  return <div className="sector-groups-page page">
    <PageHeader title={`${isMoolaPlus ? 'Moola Plus' : 'Irembo'} sector WhatsApp groups`} subtitle={`Organize ${isMoolaPlus ? 'Moola Plus' : 'Irembo'} agents by assigned sector and invite them to the right group.`} actions={<button className="btn btn-secondary" type="button" onClick={loadSectors}><RefreshCw size={15} />Refresh</button>} />
    <div className="sector-groups-guidance"><MessageCircle size={19} /><div><strong>Set up a group for each assigned sector</strong><p>Create the group in WhatsApp and save its invite link. The configured WhatsApp provider checks agent numbers and sends the invitation link to WhatsApp users. Numbers it cannot verify or that are not on WhatsApp are listed for follow-up.</p></div></div>
    <div className="sector-groups-provider-note"><strong>WhatsApp delivery</strong><p>The optional Whapi.Cloud connection checks the recorded agent numbers and sends the saved group invite link to numbers registered on WhatsApp. For automatic group setup, it can also add eligible agents directly. The provider processes the phone numbers, and members of an automatically created group can see each other’s numbers. Get each agent’s permission before sending invites or adding members.</p><small>Whapi.Cloud uses a linked WhatsApp device session. Review <a href="https://www.whatsapp.com/legal/terms-of-service" target="_blank" rel="noreferrer">WhatsApp’s terms</a> and <a href="https://faq.whatsapp.com/361005896189245/?locale=en_US" target="_blank" rel="noreferrer">group consent guidance</a> before using automated setup.</small></div>
    {notice && <p className="sector-groups-notice" role="status">{notice}</p>}
    {error && <ErrorState message={error} onRetry={loadSectors} />}
    {loading ? <LoadingState message="Loading your assigned sectors…" /> : !error && sectors.length ? <div className="sector-groups-list">
      {sectors.map((sector) => <section className="surface-card sector-group-card" key={sector.id}>
        <header><span className="sector-group-icon"><UsersRound size={18} /></span><div><span>{sector.districtName}</span><h2>{sector.name}</h2></div><strong>{sector.agents.length} agent{sector.agents.length === 1 ? '' : 's'}</strong></header>
        {sector.providerAvailable && <div className="sector-auto-group">
          <label><input type="checkbox" checked={consents[sector.id] === true} onChange={(event) => setConsents((current) => ({ ...current, [sector.id]: event.target.checked }))} /><span>I confirm that each agent to be added has agreed to join this WhatsApp group and to share their number with the provider.</span></label>
          <button type="button" className="btn btn-primary" onClick={() => createOrUpdateGroup(sector)} disabled={!consents[sector.id] || processingSector === sector.id || sector.group?.status === 'creating' || sector.group?.status === 'needs_review'}>
            <UsersRound size={15} />{processingSector === sector.id ? 'Working…' : sector.group?.status === 'active' ? 'Add new agents to group' : 'Create group and add agents'}
          </button>
          {sector.group?.status === 'active' && <small className="sector-group-status">{sector.group.groupName} · {sector.group.addedCount} added · {sector.group.failedCount} need an invite link</small>}
          {sector.group?.status === 'creating' && <small className="sector-group-status">A group creation request is being checked. Contact an administrator before trying again.</small>}
          {sector.group?.status === 'needs_review' && <small className="sector-group-status">An administrator needs to check the provider account before another group can be created.</small>}
        </div>}
        {!sector.providerAvailable && <p className="sector-group-provider-unavailable">Automatic group setup is not configured. You can still use the manual invite-link workflow below.</p>}
        <div className="sector-group-link-row"><label htmlFor={`sector-link-${sector.id}`}>WhatsApp group invite link</label>{sector.providerAvailable && !sector.group?.groupId && <label className="sector-group-invite-consent"><input type="checkbox" checked={inviteConsents[sector.id] === true} onChange={(event) => setInviteConsents((current) => ({ ...current, [sector.id]: event.target.checked }))} /><span>I confirm agents agreed to receive this invite and have their numbers checked by the WhatsApp provider.</span></label>}<div><input id={`sector-link-${sector.id}`} type="url" value={links[sector.id] || ''} disabled={sector.group?.status === 'active'} onChange={(event) => setLinks((current) => ({ ...current, [sector.id]: event.target.value }))} placeholder="https://chat.whatsapp.com/…" /><button type="button" className="btn btn-primary" onClick={() => saveLink(sector)} disabled={savingSector === sector.id || sector.group?.status === 'active' || !links[sector.id]?.trim() || (sector.providerAvailable && !sector.group?.groupId && inviteConsents[sector.id] !== true)}>{savingSector === sector.id ? 'Saving and inviting…' : 'Save link and invite agents'}</button>{links[sector.id] && !sector.group && <button type="button" className="btn btn-secondary" onClick={() => removeLink(sector)} disabled={savingSector === sector.id}>Remove saved link</button>}</div></div>
        {sector.inviteDelivery && <div className={`sector-group-delivery ${sector.inviteDelivery.status === 'complete' ? 'is-complete' : 'is-warning'}`} role="status">
          <strong>{sector.inviteDelivery.status === 'provider_unavailable' ? 'WhatsApp invitations are not configured' : sector.inviteDelivery.status === 'provider_error' ? 'WhatsApp number check needs attention' : 'Invitation follow-up'}</strong>
          {sector.inviteDelivery.status === 'provider_unavailable' && <p>The link is saved. Ask an administrator to configure the WhatsApp provider, then save the link again to send invitations.</p>}
          {sector.inviteDelivery.status === 'provider_error' && <p>The link is saved, but the provider could not check the numbers. Save the link again after the provider connection is restored.</p>}
          {sector.inviteDelivery.status === 'complete' && <p>{sector.inviteDelivery.sentCount} invitation{sector.inviteDelivery.sentCount === 1 ? '' : 's'} sent. {sector.inviteDelivery.notWhatsAppCount} number{sector.inviteDelivery.notWhatsAppCount === 1 ? ' is' : 's are'} not registered on WhatsApp.</p>}
          {[
            ['Invitation sent', sector.inviteDelivery.sentAgents],
            ['Not registered on WhatsApp', sector.inviteDelivery.notWhatsAppAgents],
            ['No phone number recorded', sector.inviteDelivery.missingPhoneAgents],
            ['Invalid phone number format', sector.inviteDelivery.invalidPhoneAgents],
            ['Message could not be sent', sector.inviteDelivery.failedAgents],
            ['Could not verify number', sector.inviteDelivery.couldNotVerifyAgents],
          ].filter(([, agents]) => agents?.length).map(([label, agents]) => <div className="sector-group-delivery-issue" key={label}><strong>{label}</strong><ul>{agents.map((agent) => <li key={agent.id}>{agent.name} · {agent.phoneNumber || 'No number recorded'}</li>)}</ul></div>)}
        </div>}
        <div className="sector-group-tools"><button type="button" onClick={() => openGroupSetup(sector)}><MessageCircle size={15} />Open WhatsApp group setup</button>{links[sector.id] && <><a href={links[sector.id]} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open invite link</a><button type="button" onClick={() => copyLink(sector)}><Copy size={15} />Copy link</button></>}<small>Create the group in WhatsApp, save its invite link, and the system will message eligible agents.</small></div>
        <div className="sector-group-agents"><h3>Agents in this sector</h3>{sector.agents.length ? <ul>{sector.agents.map((agent) => <li key={agent.id}><span className="sector-agent-avatar">{(agent.name || 'A').slice(0, 1).toUpperCase()}</span><span className="sector-agent-copy"><strong>{agent.name}</strong><small>{agent.agentId} · {agent.phoneNumber || 'No phone number recorded'}</small></span>{sector.inviteDelivery?.sentAgents?.some((item) => item.id === agent.id) ? <span className="sector-agent-invited">Invitation sent</span> : sector.inviteDelivery?.notWhatsAppAgents?.some((item) => item.id === agent.id) ? <span className="sector-agent-unavailable">Not registered on WhatsApp</span> : agent.phoneNumber && links[sector.id] ? <a className="btn btn-secondary btn-sm" href={inviteHref(sector, agent.phoneNumber)} target="_blank" rel="noreferrer"><MessageCircle size={14} />Invite on WhatsApp</a> : <span className="sector-agent-unavailable">{!agent.phoneNumber ? 'Add a phone number first' : 'Save the group link first'}</span>}</li>)}</ul> : <p className="sector-group-empty">No active agents are assigned to this sector yet.</p>}</div>
      </section>)}
    </div> : <div className="surface-card sector-group-empty-state"><UsersRound size={25} /><strong>No assigned sectors are available</strong><span>Ask an administrator to check your district assignments.</span></div>}
  </div>;
}
