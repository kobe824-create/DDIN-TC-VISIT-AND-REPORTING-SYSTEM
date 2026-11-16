import React, { useCallback, useEffect, useState } from 'react';
import { Copy, ExternalLink, MessageCircle, RefreshCw, UsersRound } from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, LoadingState } from '../components';
import { MOOLA_PLUS_NETWORK, useNetwork } from '../NetworkContext';

const areaTypes = [
  { value: 'DISTRICT', label: 'District' },
  { value: 'SECTOR', label: 'Sector' },
  { value: 'CELL', label: 'Cell' },
  { value: 'VILLAGE', label: 'Village' },
];
const phoneDigits = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return /^0\d{9}$/.test(digits) ? `250${digits.slice(1)}` : digits;
};

export default function SectorGroups() {
  const { network } = useNetwork();
  const isMoolaPlus = network === MOOLA_PLUS_NETWORK;
  const groupsEndpoint = isMoolaPlus ? '/api/v1/agents/moola-plus-whatsapp-area-groups' : '/api/v1/agents/whatsapp-area-groups';
  const [areaType, setAreaType] = useState('SECTOR');
  const [areas, setAreas] = useState([]);
  const [links, setLinks] = useState({});
  const [loading, setLoading] = useState(true);
  const [savingArea, setSavingArea] = useState('');
  const [processingArea, setProcessingArea] = useState('');
  const [consents, setConsents] = useState({});
  const [inviteConsents, setInviteConsents] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const areaLabel = areaTypes.find((item) => item.value === areaType)?.label || 'Area';

  const loadAreas = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(groupsEndpoint, { params: { type: areaType } });
      setAreas(Array.isArray(data) ? data : []);
      setLinks(Object.fromEntries((Array.isArray(data) ? data : []).map((area) => [area.id, area.inviteUrl || ''])));
    } catch (err) {
      setError(err.response?.data?.error || `Could not load your assigned ${areaLabel.toLowerCase()}s.`);
    } finally { setLoading(false); }
  }, [areaLabel, areaType, groupsEndpoint]);

  useEffect(() => { void loadAreas(); }, [loadAreas]);

  const areaUrl = (area, action = '') => `${groupsEndpoint}/${encodeURIComponent(area.id)}${action}?type=${areaType}`;
  const saveLink = async (area) => {
    setSavingArea(area.id); setError(''); setNotice('');
    try {
      const { data } = await api.put(areaUrl(area), {
        inviteUrl: links[area.id],
        confirmInviteConsent: inviteConsents[area.id] === true,
      });
      setLinks((current) => ({ ...current, [area.id]: data.inviteUrl }));
      setInviteConsents((current) => ({ ...current, [area.id]: false }));
      const delivery = data.inviteDelivery;
      if (!delivery) setNotice(`Saved invite link removed for ${area.name}.`);
      else if (delivery.status === 'provider_unavailable') setNotice(`Invite link saved for ${area.name}, but invitations were not sent because WhatsApp delivery is not configured.`);
      else if (delivery.status === 'provider_error') setNotice(`Invite link saved for ${area.name}, but WhatsApp could not verify the numbers. Retry after checking the provider connection.`);
      else setNotice(`Invite link saved for ${area.name}. ${delivery.sentCount} invitations sent; ${delivery.notWhatsAppCount} numbers are not registered on WhatsApp.`);
      await loadAreas();
    } catch (err) { setError(err.response?.data?.error || 'Could not save this WhatsApp invite.'); }
    finally { setSavingArea(''); }
  };

  const removeLink = async (area) => {
    setSavingArea(area.id); setError(''); setNotice('');
    try {
      await api.put(areaUrl(area), { inviteUrl: '' });
      setLinks((current) => ({ ...current, [area.id]: '' }));
      setNotice(`Saved invite link removed for ${area.name}.`);
    } catch (err) { setError(err.response?.data?.error || 'Could not remove this saved invite link.'); }
    finally { setSavingArea(''); }
  };

  const createOrUpdateGroup = async (area) => {
    setProcessingArea(area.id); setError(''); setNotice('');
    try {
      const { data } = await api.post(areaUrl(area, '/create'), { confirmAgentConsent: consents[area.id] === true });
      if (data.inviteUrl) setLinks((current) => ({ ...current, [area.id]: data.inviteUrl }));
      const counts = `Added ${data.addedCount} of ${data.attemptedCount} phone numbers.`;
      const skipped = data.missingPhoneCount || data.invalidPhoneCount || data.failedCount
        ? ` ${data.missingPhoneCount || 0} missing, ${data.invalidPhoneCount || 0} invalid, and ${data.failedCount || 0} not added.` : '';
      setNotice(`${data.message} ${counts}${skipped}`);
      setConsents((current) => ({ ...current, [area.id]: false }));
      await loadAreas();
    } catch (err) { setError(err.response?.data?.error || 'Could not create or update this WhatsApp group.'); }
    finally { setProcessingArea(''); }
  };

  const copyLink = async (area) => {
    try { await navigator.clipboard.writeText(links[area.id] || ''); setNotice(`Invite link copied for ${area.name}.`); }
    catch { setError('Clipboard access is unavailable. Select and copy the invite link manually.'); }
  };

  const openGroupSetup = async (area) => {
    const groupName = `DDIN ${area.name}`;
    window.open('https://web.whatsapp.com/', '_blank', 'noopener,noreferrer');
    try { await navigator.clipboard.writeText(groupName); setNotice(`“${groupName}” copied. Create the group in WhatsApp, then paste its invite link above.`); }
    catch { setNotice(`Create “${groupName}” in WhatsApp, then paste the group invite link above.`); }
  };

  const inviteMessage = (area) => `Hello, this is your TC. Join the ${area.name} agent WhatsApp group using this invite link: ${links[area.id]}`;
  const inviteHref = (area, phone) => `https://wa.me/${phoneDigits(phone)}?text=${encodeURIComponent(inviteMessage(area))}`;

  return <div className="sector-groups-page page">
    <PageHeader title={`${isMoolaPlus ? 'Moola Plus' : 'Irembo'} WhatsApp groups`} subtitle={`Organize ${isMoolaPlus ? 'Moola Plus' : 'Irembo'} agents by district, sector, cell, or village.`} actions={<button className="btn btn-secondary" type="button" onClick={loadAreas}><RefreshCw size={15} />Refresh</button>} />
    <div className="sector-groups-guidance"><MessageCircle size={19} /><div><strong>Choose the level for your WhatsApp groups</strong><p>Each group contains agents assigned to one selected area. Create the group in WhatsApp and save its invite link, or use the configured provider to set it up automatically. Get each agent’s permission before sending invitations or adding them.</p></div></div>
    <label className="sector-group-level-select">Group level<select className="input" value={areaType} onChange={(event) => { setAreaType(event.target.value); setNotice(''); setError(''); }} aria-label="WhatsApp group level">{areaTypes.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>
    <div className="sector-groups-provider-note"><strong>WhatsApp delivery</strong><p>The optional Whapi.Cloud connection checks recorded phone numbers and sends saved invite links to WhatsApp users. Automatic group setup also adds eligible agents directly. Members of an automatically created group can see each other’s numbers.</p><small>Whapi.Cloud uses a linked WhatsApp device session. Review <a href="https://www.whatsapp.com/legal/terms-of-service" target="_blank" rel="noreferrer">WhatsApp’s terms</a> and <a href="https://faq.whatsapp.com/361005896189245/?locale=en_US" target="_blank" rel="noreferrer">group consent guidance</a> before using automated setup.</small></div>
    {notice && <p className="sector-groups-notice" role="status">{notice}</p>}
    {error && <ErrorState message={error} onRetry={loadAreas} />}
    {loading ? <LoadingState message={`Loading your assigned ${areaLabel.toLowerCase()} groups…`} /> : !error && areas.length ? <div className="sector-groups-list">
      {areas.map((area) => <section className="surface-card sector-group-card" key={area.id}>
        <header><span className="sector-group-icon"><UsersRound size={18} /></span><div><span>{area.path || area.districtName || area.parentName}</span><h2>{area.name}</h2></div><strong>{area.agents.length} agent{area.agents.length === 1 ? '' : 's'}</strong></header>
        {area.providerAvailable && <div className="sector-auto-group">
          <label><input type="checkbox" checked={consents[area.id] === true} onChange={(event) => setConsents((current) => ({ ...current, [area.id]: event.target.checked }))} /><span>I confirm that each agent to be added agreed to join this WhatsApp group and share their number with the provider.</span></label>
          <button type="button" className="btn btn-primary" onClick={() => createOrUpdateGroup(area)} disabled={!consents[area.id] || processingArea === area.id || area.group?.status === 'creating' || area.group?.status === 'needs_review'}>
            <UsersRound size={15} />{processingArea === area.id ? 'Working…' : area.group?.status === 'active' ? 'Add new agents to group' : 'Create group and add agents'}
          </button>
          {area.group?.status === 'active' && <small className="sector-group-status">{area.group.groupName} · {area.group.addedCount} added · {area.group.failedCount} need an invite link</small>}
          {area.group?.status === 'creating' && <small className="sector-group-status">A group creation request is being checked. Contact an administrator before trying again.</small>}
          {area.group?.status === 'needs_review' && <small className="sector-group-status">An administrator needs to check the provider account before another group action.</small>}
        </div>}
        {!area.providerAvailable && <p className="sector-group-provider-unavailable">Automatic group setup is not configured. You can still use the manual invite-link workflow below.</p>}
        <div className="sector-group-link-row"><label htmlFor={`area-link-${area.id}`}>WhatsApp group invite link</label>{area.providerAvailable && !area.group?.groupId && <label className="sector-group-invite-consent"><input type="checkbox" checked={inviteConsents[area.id] === true} onChange={(event) => setInviteConsents((current) => ({ ...current, [area.id]: event.target.checked }))} /><span>I confirm agents agreed to receive this invite and have their numbers checked by the provider.</span></label>}<div><input id={`area-link-${area.id}`} type="url" value={links[area.id] || ''} disabled={area.group?.status === 'active'} onChange={(event) => setLinks((current) => ({ ...current, [area.id]: event.target.value }))} placeholder="https://chat.whatsapp.com/…" /><button type="button" className="btn btn-primary" onClick={() => saveLink(area)} disabled={savingArea === area.id || area.group?.status === 'active' || !links[area.id]?.trim() || (area.providerAvailable && !area.group?.groupId && inviteConsents[area.id] !== true)}>{savingArea === area.id ? 'Saving and inviting…' : 'Save link and invite agents'}</button>{links[area.id] && !area.group && <button type="button" className="btn btn-secondary" onClick={() => removeLink(area)} disabled={savingArea === area.id}>Remove saved link</button>}</div></div>
        {area.inviteDelivery && <div className={`sector-group-delivery ${area.inviteDelivery.status === 'complete' ? 'is-complete' : 'is-warning'}`} role="status">
          <strong>{area.inviteDelivery.status === 'provider_unavailable' ? 'WhatsApp invitations are not configured' : area.inviteDelivery.status === 'provider_error' ? 'WhatsApp number check needs attention' : 'Invitation follow-up'}</strong>
          {area.inviteDelivery.status === 'provider_unavailable' && <p>The link is saved. Ask an administrator to configure WhatsApp delivery, then save the link again to send invitations.</p>}
          {area.inviteDelivery.status === 'provider_error' && <p>The link is saved, but the provider could not check the numbers. Save the link again after the connection is restored.</p>}
          {area.inviteDelivery.status === 'complete' && <p>{area.inviteDelivery.sentCount} invitation{area.inviteDelivery.sentCount === 1 ? '' : 's'} sent. {area.inviteDelivery.notWhatsAppCount} number{area.inviteDelivery.notWhatsAppCount === 1 ? ' is' : 's are'} not registered on WhatsApp.</p>}
          {[
            ['Invitation sent', area.inviteDelivery.sentAgents], ['Not registered on WhatsApp', area.inviteDelivery.notWhatsAppAgents],
            ['No phone number recorded', area.inviteDelivery.missingPhoneAgents], ['Invalid phone number format', area.inviteDelivery.invalidPhoneAgents],
            ['Message could not be sent', area.inviteDelivery.failedAgents], ['Could not verify number', area.inviteDelivery.couldNotVerifyAgents],
          ].filter(([, agents]) => agents?.length).map(([label, agents]) => <div className="sector-group-delivery-issue" key={label}><strong>{label}</strong><ul>{agents.map((agent) => <li key={agent.id}>{agent.name} · {agent.phoneNumber || 'No number recorded'}</li>)}</ul></div>)}
        </div>}
        <div className="sector-group-tools"><button type="button" onClick={() => openGroupSetup(area)}><MessageCircle size={15} />Open WhatsApp group setup</button>{links[area.id] && <><a href={links[area.id]} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open invite link</a><button type="button" onClick={() => copyLink(area)}><Copy size={15} />Copy link</button></>}<small>Create the group in WhatsApp, save its invite link, then invite eligible agents.</small></div>
        <div className="sector-group-agents"><h3>Agents in this {areaLabel.toLowerCase()}</h3>{area.agents.length ? <ul>{area.agents.map((agent) => <li key={agent.id}><span className="sector-agent-avatar">{(agent.name || 'A').slice(0, 1).toUpperCase()}</span><span className="sector-agent-copy"><strong>{agent.name}</strong><small>{agent.agentId} · {agent.phoneNumber || 'No phone number recorded'}</small></span>{area.inviteDelivery?.sentAgents?.some((item) => item.id === agent.id) ? <span className="sector-agent-invited">Invitation sent</span> : area.inviteDelivery?.notWhatsAppAgents?.some((item) => item.id === agent.id) ? <span className="sector-agent-unavailable">Not registered on WhatsApp</span> : agent.phoneNumber && links[area.id] ? <a className="btn btn-secondary btn-sm" href={inviteHref(area, agent.phoneNumber)} target="_blank" rel="noreferrer"><MessageCircle size={14} />Invite on WhatsApp</a> : <span className="sector-agent-unavailable">{!agent.phoneNumber ? 'Add a phone number first' : 'Save the group link first'}</span>}</li>)}</ul> : <p className="sector-group-empty">No active agents are assigned to this {areaLabel.toLowerCase()} yet.</p>}</div>
      </section>)}
    </div> : <div className="surface-card sector-group-empty-state"><UsersRound size={25} /><strong>No assigned {areaLabel.toLowerCase()}s are available</strong><span>Ask an administrator to check your district assignments and territory list.</span></div>}
  </div>;
}
