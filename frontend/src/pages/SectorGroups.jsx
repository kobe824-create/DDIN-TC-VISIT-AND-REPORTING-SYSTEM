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

function MoolaPlusSectorGroups() {
  const groupsEndpoint = '/api/v1/agents/moola-plus-sector-groups';
  const [sectors, setSectors] = useState([]);
  const [groupLevel, setGroupLevel] = useState('SECTOR');
  const [groupNames, setGroupNames] = useState({});
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
      const { data } = await api.get(groupsEndpoint, { params: { level: groupLevel } });
      const rows = Array.isArray(data) ? data : [];
      setSectors(rows);
      setLinks(Object.fromEntries(rows.map((sector) => [sector.id, sector.inviteUrl || ''])));
      setGroupNames((current) => Object.fromEntries(rows.map((sector) => [sector.id, sector.group?.groupName || current[sector.id] || `DDIN ${sector.name}`.slice(0, 25)])));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load your assigned sectors.');
    } finally { setLoading(false); }
  }, [groupsEndpoint, groupLevel]);

  useEffect(() => { loadSectors(); }, [loadSectors]);

  const saveLink = async (sector) => {
    setSavingSector(sector.id);
    setError(''); setNotice('');
    try {
      const { data } = await api.put(`${groupsEndpoint}/${sector.id}`, {
        inviteUrl: links[sector.id],
        confirmInviteConsent: inviteConsents[sector.id] === true,
        groupLevel,
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
      await api.put(`${groupsEndpoint}/${sector.id}`, { inviteUrl: '', groupLevel });
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
      const { data } = await api.post(`${groupsEndpoint}/${sector.id}/create`, {
        confirmAgentConsent: consents[sector.id] === true,
        groupLevel,
        groupName: groupNames[sector.id],
      });
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
    const groupName = groupNames[sector.id] || `DDIN ${sector.name}`.slice(0, 25);
    window.open('https://web.whatsapp.com/', '_blank', 'noopener,noreferrer');
    try {
      await navigator.clipboard.writeText(groupName);
      setNotice(`“${groupName}” copied. Create the group in WhatsApp, then paste its invite link above.`);
    } catch {
      setNotice(`Create “${groupName}” in WhatsApp, then paste the group invite link above.`);
    }
  };

  const inviteMessage = (sector) => `Hello, this is your TC. Join the ${sector.breadcrumb || sector.name} agent WhatsApp group using this invite link: ${links[sector.id]}`;
  const inviteHref = (sector, phone) => `https://wa.me/${phoneDigits(phone)}?text=${encodeURIComponent(inviteMessage(sector))}`;

  return <div className="sector-groups-page page">
    <PageHeader title="Moola Plus WhatsApp groups" subtitle="Choose a location level and create a group for the agents listed in each territory." actions={<div className="whatsapp-groups-actions"><label>Group level<select value={groupLevel} onChange={(event) => setGroupLevel(event.target.value)}><option value="DISTRICT">District</option><option value="SECTOR">Sector</option><option value="CELL">Cell</option><option value="VILLAGE">Village</option></select></label><button className="btn btn-secondary" type="button" onClick={loadSectors}><RefreshCw size={15} />Refresh</button></div>} />
    <div className="sector-groups-guidance"><MessageCircle size={19} /><div><strong>Create a group for each territory in the selected level</strong><p>Choose District, Sector, Cell, or Village. Each territory card shows the Moola Plus agents found there; enter a group name and the system adds their recorded numbers.</p></div></div>
    <div className="sector-groups-provider-note"><strong>WhatsApp delivery</strong><p>The optional Whapi.Cloud connection checks the recorded agent numbers and sends the saved group invite link to numbers registered on WhatsApp. For automatic group setup, it can also add eligible agents directly. The provider processes the phone numbers, and members of an automatically created group can see each other’s numbers. Get each agent’s permission before sending invites or adding members.</p><small>Whapi.Cloud uses a linked WhatsApp device session. Review <a href="https://www.whatsapp.com/legal/terms-of-service" target="_blank" rel="noreferrer">WhatsApp’s terms</a> and <a href="https://faq.whatsapp.com/361005896189245/?locale=en_US" target="_blank" rel="noreferrer">group consent guidance</a> before using automated setup.</small></div>
    {notice && <p className="sector-groups-notice" role="status">{notice}</p>}
    {error && <ErrorState message={error} onRetry={loadSectors} />}
    {loading ? <LoadingState message="Loading Moola Plus territories…" /> : !error && sectors.length ? <div className="sector-groups-list">
      {sectors.map((sector) => <section className="surface-card sector-group-card" key={sector.id}>
        <header><span className="sector-group-icon"><UsersRound size={18} /></span><div><span>{sector.districtName}</span><h2>{sector.breadcrumb || sector.name}</h2></div><strong>{sector.agents.length} agent{sector.agents.length === 1 ? '' : 's'}</strong></header>
        {sector.providerAvailable && <div className="sector-auto-group">
          <div className="sector-group-name-field"><label htmlFor={`moola-group-name-${sector.id}`}>WhatsApp group name</label><input id={`moola-group-name-${sector.id}`} value={groupNames[sector.id] || ''} maxLength={25} disabled={Boolean(sector.group?.providerManaged)} onChange={(event) => setGroupNames((current) => ({ ...current, [sector.id]: event.target.value }))} placeholder="Enter a group name" /><small>{(groupNames[sector.id] || '').length}/25 characters</small></div>
          <label><input type="checkbox" checked={consents[sector.id] === true} onChange={(event) => setConsents((current) => ({ ...current, [sector.id]: event.target.checked }))} /><span>I confirm that each agent to be added has agreed to join this WhatsApp group and to share their number with the provider.</span></label>
          {links[sector.id] && !sector.group?.providerManaged && <small className="sector-group-status">A manual invite link is saved. Remove it below before creating a provider-managed group.</small>}
          <button type="button" className="btn btn-primary" onClick={() => createOrUpdateGroup(sector)} disabled={!consents[sector.id] || !groupNames[sector.id]?.trim() || groupNames[sector.id]?.trim().length > 25 || (Boolean(links[sector.id]) && !sector.group?.providerManaged) || processingSector === sector.id || sector.group?.status === 'creating' || sector.group?.status === 'needs_review'}>
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
    </div> : <div className="surface-card sector-group-empty-state"><UsersRound size={25} /><strong>No {groupLevel.toLocaleLowerCase()} territories are available</strong><span>There are no Moola Plus agents with a recorded location at this level in your assigned districts.</span></div>}
  </div>;
}

function IremboTerritoryGroups() {
  const [territories, setTerritories] = useState([]);
  const [groupLevel, setGroupLevel] = useState('DISTRICT');
  const [territoryId, setTerritoryId] = useState('');
  const [groupName, setGroupName] = useState('');
  const [providerAvailable, setProviderAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadTerritories = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/api/v1/agents/territory-whatsapp-groups');
      setTerritories(Array.isArray(data.territories) ? data.territories : []);
      setProviderAvailable(data.providerAvailable === true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load available territories.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadTerritories(); }, [loadTerritories]);

  const levelTerritories = territories.filter((territory) => territory.type === groupLevel);
  const selectedTerritory = territories.find((territory) => territory.id === territoryId);

  useEffect(() => {
    const choices = territories.filter((territory) => territory.type === groupLevel);
    if (choices.some((territory) => territory.id === territoryId)) return;
    const first = choices[0];
    setTerritoryId(first?.id || '');
    setGroupName(first?.group?.groupName || (first ? `DDIN ${first.name}`.slice(0, 25) : ''));
    setConsentConfirmed(false);
  }, [territories, groupLevel, territoryId]);

  const changeLevel = (value) => {
    setGroupLevel(value);
    setTerritoryId('');
    setGroupName('');
    setConsentConfirmed(false);
    setError(''); setNotice('');
  };

  const changeTerritory = (value) => {
    const next = territories.find((territory) => territory.id === value);
    setTerritoryId(value);
    setGroupName(next?.group?.groupName || (next ? `DDIN ${next.name}`.slice(0, 25) : ''));
    setConsentConfirmed(false);
    setError(''); setNotice('');
  };

  const createOrUpdateGroup = async () => {
    if (!selectedTerritory) return;
    setProcessing(true);
    setError(''); setNotice('');
    try {
      const { data } = await api.post(`/api/v1/agents/territory-whatsapp-groups/${selectedTerritory.id}/create`, {
        groupName: groupName.trim(), confirmAgentConsent: consentConfirmed,
      });
      const extra = ` Added ${data.addedCount} of ${data.attemptedCount} phone numbers.`
        + (data.missingPhoneCount || data.invalidPhoneCount || data.failedCount
          ? ` ${data.missingPhoneCount || 0} agents have no number, ${data.invalidPhoneCount || 0} numbers are invalid, and ${data.failedCount || 0} could not be added.` : '');
      setNotice(`${data.message}${extra}`);
      setConsentConfirmed(false);
      await loadTerritories();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create or update this WhatsApp group.');
    } finally { setProcessing(false); }
  };

  const removeManualInvite = async () => {
    if (selectedTerritory?.type !== 'SECTOR' || !selectedTerritory.manualInviteUrl) return;
    const shouldRemove = window.confirm('Remove the saved invite link and its invitation status from the system? This will not delete the WhatsApp group or remove its members. Copy the link first if you still need it.');
    if (!shouldRemove) return;
    setProcessing(true);
    setError(''); setNotice('');
    try {
      await api.put(`/api/v1/agents/sector-groups/${selectedTerritory.id}`, { inviteUrl: '' });
      setNotice('The saved invite link was removed from the system. The WhatsApp group itself is unchanged.');
      await loadTerritories();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove the saved invite link.');
    } finally { setProcessing(false); }
  };

  const busyStatus = ['creating', 'needs_review'].includes(selectedTerritory?.group?.status);
  const canCreate = providerAvailable && selectedTerritory && selectedTerritory.validPhoneCount > 0
    && groupName.trim() && groupName.trim().length <= 25 && consentConfirmed && !busyStatus && !selectedTerritory.manualInviteUrl;

  return <div className="sector-groups-page page">
    <PageHeader title="Irembo WhatsApp groups" subtitle="Choose a territory and group name. The system creates the group and adds its active agents." actions={<button className="btn btn-secondary" type="button" onClick={loadTerritories}><RefreshCw size={15} />Refresh</button>} />
    <div className="sector-groups-guidance"><MessageCircle size={19} /><div><strong>Create one group for a district, sector, cell, or village</strong><p>The system uses the active agents recorded in the selected territory, including their saved phone numbers. District coordinators can only create groups inside their assigned districts.</p></div></div>
    <div className="sector-groups-provider-note"><strong>WhatsApp number privacy</strong><p>Whapi uses the connected WhatsApp channel to create the group and add agent numbers. Group members can see one another’s numbers. Confirm that agents agreed before adding them.</p><small>The Whapi channel API token stays on the backend server; the browser never receives it.</small></div>
    {notice && <p className="sector-groups-notice" role="status">{notice}</p>}
    {error && <ErrorState message={error} onRetry={loadTerritories} />}
    {loading ? <LoadingState message="Loading your assigned territories…" /> : !error && territories.length ? <section className="surface-card territory-group-builder">
      <div className="territory-group-fields">
        <label>Group level<select value={groupLevel} onChange={(event) => changeLevel(event.target.value)}><option value="DISTRICT">District</option><option value="SECTOR">Sector</option><option value="CELL">Cell</option><option value="VILLAGE">Village</option></select></label>
        <label>Territory<select value={territoryId} onChange={(event) => changeTerritory(event.target.value)}>{levelTerritories.map((territory) => <option value={territory.id} key={territory.id}>{territory.breadcrumb}</option>)}</select></label>
        <label>WhatsApp group name<input value={groupName} maxLength={25} disabled={Boolean(selectedTerritory?.group?.providerManaged)} onChange={(event) => setGroupName(event.target.value)} placeholder="Enter a group name" /><small>{groupName.length}/25 characters</small></label>
      </div>
      {!levelTerritories.length && <p className="sector-group-provider-unavailable">There are no active {groupLevel.toLocaleLowerCase()} territories in your assigned districts.</p>}
      {selectedTerritory && <div className="territory-group-summary"><UsersRound size={17} /><span><strong>{selectedTerritory.agentCount} active agents</strong> in {selectedTerritory.breadcrumb}. {selectedTerritory.validPhoneCount} have valid phone numbers{selectedTerritory.missingPhoneCount ? `, ${selectedTerritory.missingPhoneCount} have no number` : ''}{selectedTerritory.invalidPhoneCount ? `, ${selectedTerritory.invalidPhoneCount} have an invalid number` : ''}.</span></div>}
      {selectedTerritory?.manualInviteUrl && <div className="territory-group-warning" role="status"><strong>A manual invite link is already saved for this sector.</strong><span>Open or copy the existing group link first. To avoid creating a second group, remove the saved link before creating a managed group.</span><a href={selectedTerritory.manualInviteUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />Open saved group</a><button type="button" className="btn btn-secondary btn-sm" onClick={removeManualInvite} disabled={processing}>Remove saved link from system</button></div>}
      {selectedTerritory?.group?.status === 'creating' && <p className="territory-group-warning" role="status">A Whapi group creation may still be in progress. Check the channel before retrying.</p>}
      {selectedTerritory?.group?.status === 'needs_review' && <p className="territory-group-warning" role="status">An administrator must review the Whapi channel before this group can be changed.</p>}
      {!providerAvailable && <p className="sector-group-provider-unavailable">Automatic group setup is not configured. Ask an administrator to add the channel API token to AgentsService on the server.</p>}
      {selectedTerritory?.group?.providerManaged && <div className="territory-group-summary"><MessageCircle size={17} /><span><strong>{selectedTerritory.group.groupName}</strong> · {selectedTerritory.group.addedCount} agents added · {selectedTerritory.group.failedCount} need follow-up{selectedTerritory.group.inviteUrl ? <> · <a href={selectedTerritory.group.inviteUrl} target="_blank" rel="noreferrer">Open invite link</a></> : null}</span></div>}
      <div className="sector-auto-group territory-group-action">
        <label><input type="checkbox" checked={consentConfirmed} onChange={(event) => setConsentConfirmed(event.target.checked)} /><span>I confirm that the active agents in this territory agreed to join the group and share their phone numbers with the WhatsApp provider.</span></label>
        <button type="button" className="btn btn-primary" onClick={createOrUpdateGroup} disabled={!canCreate || processing}>
          <UsersRound size={15} />{processing ? 'Working…' : selectedTerritory?.group?.status === 'active' ? 'Add new agents to group' : 'Create group and add agents'}
        </button>
      </div>
    </section> : !error && <div className="surface-card sector-group-empty-state"><UsersRound size={25} /><strong>No assigned territories are available</strong><span>Ask an administrator to check your district assignments.</span></div>}
  </div>;
}

export default function SectorGroups() {
  const { network } = useNetwork();
  return network === MOOLA_PLUS_NETWORK ? <MoolaPlusSectorGroups /> : <IremboTerritoryGroups />;
}
