import React, { useCallback, useEffect, useState } from 'react';
import { Copy, ExternalLink, MessageCircle, RefreshCw, UsersRound } from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import { ErrorState, LoadingState } from '../components';

const phoneDigits = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return /^0\d{9}$/.test(digits) ? `250${digits.slice(1)}` : digits;
};

export default function SectorGroups() {
  const [sectors, setSectors] = useState([]);
  const [links, setLinks] = useState({});
  const [loading, setLoading] = useState(true);
  const [savingSector, setSavingSector] = useState('');
  const [processingSector, setProcessingSector] = useState('');
  const [consents, setConsents] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadSectors = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/api/v1/agents/sector-groups');
      setSectors(Array.isArray(data) ? data : []);
      setLinks(Object.fromEntries((Array.isArray(data) ? data : []).map((sector) => [sector.id, sector.inviteUrl || ''])));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load your assigned sectors.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadSectors(); }, [loadSectors]);

  const saveLink = async (sector) => {
    setSavingSector(sector.id);
    setError(''); setNotice('');
    try {
      const { data } = await api.put(`/api/v1/agents/sector-groups/${sector.id}`, { inviteUrl: links[sector.id] });
      setLinks((current) => ({ ...current, [sector.id]: data.inviteUrl }));
      setNotice(data.inviteUrl ? `WhatsApp invite saved for ${sector.name}.` : `Saved invite link removed for ${sector.name}.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save this WhatsApp invite.');
    } finally { setSavingSector(''); }
  };

  const removeLink = async (sector) => {
    setSavingSector(sector.id);
    setError(''); setNotice('');
    try {
      await api.put(`/api/v1/agents/sector-groups/${sector.id}`, { inviteUrl: '' });
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
      const { data } = await api.post(`/api/v1/agents/sector-groups/${sector.id}/create`, { confirmAgentConsent: consents[sector.id] === true });
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
    <PageHeader title="Sector WhatsApp groups" subtitle="Organize agents by your assigned sectors and send each person a group invitation." actions={<button className="btn btn-secondary" type="button" onClick={loadSectors}><RefreshCw size={15} />Refresh</button>} />
    <div className="sector-groups-guidance"><MessageCircle size={19} /><div><strong>Set up a group for each assigned sector</strong><p>Use automatic setup if the provider is configured and every agent has agreed, or create a group in WhatsApp and save its invite link here. Agents who cannot be added automatically can join through that link.</p></div></div>
    <div className="sector-groups-provider-note"><strong>Automatic group setup</strong><p>When an administrator configures the optional Whapi.Cloud connection, you can create a group and add agents with valid phone numbers. This sends those numbers to an external provider and can reveal them to everyone in the group. Get each agent’s permission first. If WhatsApp blocks an addition, use the invite link so that agent can choose to join.</p><small>Whapi.Cloud uses a linked WhatsApp device session. Review <a href="https://www.whatsapp.com/legal/terms-of-service" target="_blank" rel="noreferrer">WhatsApp’s terms</a> and <a href="https://faq.whatsapp.com/361005896189245/?locale=en_US" target="_blank" rel="noreferrer">group consent guidance</a> before using automated setup.</small></div>
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
        <div className="sector-group-link-row"><label htmlFor={`sector-link-${sector.id}`}>WhatsApp group invite link</label><div><input id={`sector-link-${sector.id}`} type="url" value={links[sector.id] || ''} disabled={sector.group?.status === 'active'} onChange={(event) => setLinks((current) => ({ ...current, [sector.id]: event.target.value }))} placeholder="https://chat.whatsapp.com/…" /><button type="button" className="btn btn-primary" onClick={() => saveLink(sector)} disabled={savingSector === sector.id || sector.group?.status === 'active' || !links[sector.id]?.trim()}>{savingSector === sector.id ? 'Saving…' : 'Save group link'}</button>{links[sector.id] && !sector.group && <button type="button" className="btn btn-secondary" onClick={() => removeLink(sector)} disabled={savingSector === sector.id}>Remove saved link</button>}</div></div>
        <div className="sector-group-tools"><button type="button" onClick={() => openGroupSetup(sector)}><MessageCircle size={15} />Open WhatsApp group setup</button>{links[sector.id] && <><a href={links[sector.id]} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open invite link</a><button type="button" onClick={() => copyLink(sector)}><Copy size={15} />Copy link</button></>}<small>Create the group in WhatsApp, save its invite link above, then invite agents individually below.</small></div>
        <div className="sector-group-agents"><h3>Agents in this sector</h3>{sector.agents.length ? <ul>{sector.agents.map((agent) => <li key={agent.id}><span className="sector-agent-avatar">{(agent.name || 'A').slice(0, 1).toUpperCase()}</span><span className="sector-agent-copy"><strong>{agent.name}</strong><small>{agent.agentId} · {agent.phoneNumber || 'No phone number recorded'}</small></span>{agent.phoneNumber && links[sector.id] ? <a className="btn btn-secondary btn-sm" href={inviteHref(sector, agent.phoneNumber)} target="_blank" rel="noreferrer"><MessageCircle size={14} />Invite on WhatsApp</a> : <span className="sector-agent-unavailable">{!agent.phoneNumber ? 'Add a phone number first' : 'Save the group link first'}</span>}</li>)}</ul> : <p className="sector-group-empty">No active agents are assigned to this sector yet.</p>}</div>
      </section>)}
    </div> : <div className="surface-card sector-group-empty-state"><UsersRound size={25} /><strong>No assigned sectors are available</strong><span>Ask an administrator to check your district assignments.</span></div>}
  </div>;
}
