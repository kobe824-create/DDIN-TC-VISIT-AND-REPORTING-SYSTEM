import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, Download, FileSpreadsheet, KeyRound, Upload } from 'lucide-react';
import api from '../api';
import { useAuth } from '../AuthContext';
import PageHeader from '../components/PageHeader';

const IMPORTS = {
  agents: {
    label: 'Agents',
    previewUrl: '/api/v1/agents/bulk-import/preview',
    importUrl: '/api/v1/agents/bulk-import',
  },
  tcs: {
    label: 'Territory coordinators',
    previewUrl: '/api/v1/users/bulk-import/preview',
    importUrl: '/api/v1/users/bulk-import',
  },
};

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(fileName, headers, rows) {
  const content = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

async function encodeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export default function BulkImport() {
  const { user } = useAuth();
  const isAdmin = user?.role?.toUpperCase() === 'ADMIN';
  const isTc = user?.role?.toUpperCase() === 'TC';
  const [kind, setKind] = useState('agents');
  const [file, setFile] = useState(null);
  const [encodedFile, setEncodedFile] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [credentials, setCredentials] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const config = IMPORTS[kind];

  const allIssues = useMemo(() => [
    ...(preview?.errors || []),
    ...(preview?.warnings || []).map((warning) => ({ row: warning.row, reasons: [warning.reason], warning: true })),
  ], [preview]);

  const selectKind = (value) => {
    setKind(value);
    setFile(null);
    setEncodedFile('');
    setPreview(null);
    setResult(null);
    setCredentials([]);
    setError('');
  };

  const selectFile = async (event) => {
    const chosen = event.target.files?.[0] || null;
    setFile(chosen);
    setEncodedFile('');
    setPreview(null);
    setResult(null);
    setCredentials([]);
    setError('');
    if (!chosen) return;
    if (!/\.(xlsx|csv)$/i.test(chosen.name)) {
      setError('Choose an .xlsx or .csv file.');
      setFile(null);
      return;
    }
    if (chosen.size > 8 * 1024 * 1024) {
      setError('The spreadsheet must be 8 MB or smaller.');
      setFile(null);
      return;
    }
    try {
      setEncodedFile(await encodeFile(chosen));
    } catch {
      setError('Could not read this file. Save it as .xlsx or .csv and try again.');
      setFile(null);
    }
  };

  const previewImport = async () => {
    if (!file || !encodedFile) return;
    setBusy(true);
    setError('');
    setResult(null);
    setCredentials([]);
    try {
      const response = await api.post(config.previewUrl, { fileName: file.name, fileBase64: encodedFile });
      setPreview(response.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not validate this spreadsheet.');
      setPreview(null);
    } finally { setBusy(false); }
  };

  const commitImport = async () => {
    if (!file || !encodedFile || !(preview?.summary?.importable || preview?.summary?.enrichable)) return;
    const confirmation = kind === 'agents'
      ? (isTc
        ? `Register ${preview.summary.importable.toLocaleString()} agents in your assigned districts and save ${preview.summary.agentPhoneNumbersToAdd || 0} agent phone numbers? Existing agents can only be enriched in your assigned districts.`
        : `Import ${preview.summary.importable.toLocaleString()} new agent rows and save ${preview.summary.agentPhoneNumbersToAdd || 0} agent phone numbers? Missing contact and personal details will be added to ${preview.summary.enrichable || 0} matching records. Agent phone numbers are available to TCs; IDs and next-of-kin details are encrypted in the database.`)
      : `Create ${preview.summary.importable.toLocaleString()} TC accounts? Temporary passwords will be shown once and each account must change its password within 24 hours.`;
    if (!window.confirm(confirmation)) return;
    setBusy(true);
    setError('');
    try {
      const response = await api.post(config.importUrl, { fileName: file.name, fileBase64: encodedFile });
      setResult(response.data.summary);
      setPreview(response.data);
      setCredentials(response.data.credentials || []);
    } catch (err) {
      setError(err.response?.data?.error || 'The import could not be completed.');
      if (err.response?.data?.errors) setPreview(err.response.data);
    } finally { setBusy(false); }
  };

  const exportIssues = () => {
    const rows = allIssues.map((issue) => [
      Array.isArray(issue.rows) ? issue.rows.join('; ') : issue.row || '',
      issue.key || '',
      (issue.reasons || []).join(' '),
      issue.warning ? 'Warning' : 'Held',
    ]);
    downloadCsv(`${kind}-import-review.csv`, ['Source row', 'Record key', 'Issue', 'Status'], rows);
  };

  const exportCredentials = () => downloadCsv('tc-temporary-credentials.csv',
    ['Name', 'Username', 'Email', 'Phone', 'Districts', 'Temporary password', 'Expires'],
    credentials.map((item) => [item.name, item.username, item.email, item.phoneNumber, item.districts.join('; '), item.temporaryPassword, item.expiresAt]));

  return <div className="page bulk-import-page">
    <PageHeader title="Bulk registration" subtitle={isTc ? 'Validate and register agents in your assigned districts.' : 'Validate a spreadsheet before importing agent records or creating coordinator accounts.'} />

    <section className="surface-card bulk-import-card">
      <div className="form-grid-two">
        {isAdmin && <label className="form-field"><span>Records to import</span><select className="input" value={kind} onChange={(event) => selectKind(event.target.value)} disabled={busy}>
          <option value="agents">Agents</option><option value="tcs">Territory coordinators</option>
        </select></label>}
        <label className="form-field"><span>{isTc ? 'Agent spreadsheet (.xlsx or .csv)' : 'Spreadsheet (.xlsx or .csv)'}</span><input className="input" type="file" accept=".xlsx,.csv" onChange={selectFile} disabled={busy} /></label>
      </div>

      <div className="bulk-import-guidance">
        <FileSpreadsheet size={18} />
        {kind === 'agents' ? <p>{isTc ? 'Import Agent Code, name, province, district, existing sector and contact details for agents in your assigned districts. Rows outside your assignments, or with sectors that are not registered in those districts, will be held for review. National ID and next-of-kin details are not imported for TC accounts. GPS remains unverified until a TC captures it at the agent location.' : 'Import Agent Code, name, territory and contact details. The March roster’s AGENT USERNAME values are used as agent phone numbers when they match a Rwanda mobile number; an explicit agent phone column takes priority. National ID and next-of-kin values are encrypted and visible only to admins. GPS remains unverified until a TC captures it at the agent location.'}</p>
          : <p>Import TC name, phone, email and comma-separated districts. For incoming TCs whose contact details are pending, leave phone blank and use a reserved @ddin.test email; replace these placeholders from account management when confirmed. Import the agents workbook first so its district records exist. All new TC accounts receive the same configured temporary password, which expires after 24 hours and must be changed at first sign-in.</p>}
      </div>
      {file && <p className="bulk-import-file"><strong>Selected:</strong> {file.name} <span>({(file.size / 1024).toFixed(0)} KB)</span></p>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {result && <div className="alert alert-success" role="status"><Check size={16} />Imported {result.imported.toLocaleString()} {kind === 'agents' ? 'agents' : 'TC accounts'}{kind === 'agents' && result.agentPhoneNumbersToAdd ? ` and saved ${result.agentPhoneNumbersToAdd.toLocaleString()} agent phone numbers` : ''}{kind === 'agents' && result.enriched ? `; added missing details to ${result.enriched.toLocaleString()} existing agents` : ''}.</div>}

      <div className="form-submit-row bulk-import-actions">
        <button type="button" className="btn btn-secondary" onClick={previewImport} disabled={!file || !encodedFile || busy}><FileSpreadsheet size={16} />{busy && !result ? 'Working…' : 'Validate file'}</button>
        {(preview?.summary?.importable > 0 || preview?.summary?.enrichable > 0) && !result && <button type="button" className="btn btn-primary" onClick={commitImport} disabled={busy}><Upload size={16} />{busy ? 'Importing…' : preview.summary.importable ? `Import ${preview.summary.importable.toLocaleString()} new rows` : `Add details to ${preview.summary.enrichable.toLocaleString()} matching agents`}</button>}
      </div>
    </section>

    {preview?.summary && <section className="surface-card bulk-import-summary">
      <div className="surface-heading"><div><span className="section-kicker">VALIDATION</span><h2>{result ? 'Import result' : 'Preview'}</h2></div></div>
      <div className="bulk-import-metrics">
        <div><span>Rows</span><strong>{preview.summary.rows.toLocaleString()}</strong></div>
        <div><span>Ready</span><strong>{preview.summary.importable.toLocaleString()}</strong></div>
        {preview.summary.alreadyPresent !== undefined && <div><span>Already present</span><strong>{preview.summary.alreadyPresent.toLocaleString()}</strong></div>}
        {preview.summary.agentPhoneNumbersToAdd !== undefined && <div><span>{result ? 'Phone numbers saved' : 'Phone numbers to add'}</span><strong>{preview.summary.agentPhoneNumbersToAdd.toLocaleString()}</strong></div>}
        {preview.summary.enrichable !== undefined && <div><span>Matching records to update</span><strong>{preview.summary.enrichable.toLocaleString()}</strong></div>}
        <div><span>Held for review</span><strong>{preview.summary.errors.toLocaleString()}</strong></div>
        {preview.summary.warnings !== undefined && <div><span>Warnings</span><strong>{preview.summary.warnings.toLocaleString()}</strong></div>}
        {result && <div><span>Imported</span><strong>{result.imported.toLocaleString()}</strong></div>}
      </div>
      {kind === 'agents' && preview.summary.importable > 0 && !result && <div className="bulk-import-guidance"><AlertTriangle size={17} /><p>Existing agent IDs are never overwritten. Duplicate IDs in this upload are held together so you can correct them at the source.</p></div>}
      {allIssues.length > 0 && <>
        <div className="bulk-import-issue-heading"><h3>Rows to review ({allIssues.length})</h3><button className="btn btn-secondary btn-sm" type="button" onClick={exportIssues}><Download size={14} />Download review CSV</button></div>
        <div className="bulk-import-issues"><table className="data-table"><thead><tr><th>Row</th><th>Record</th><th>Issue</th></tr></thead><tbody>{allIssues.slice(0, 30).map((issue, index) => <tr key={`${issue.row || issue.rows?.[0]}-${index}`}><td>{Array.isArray(issue.rows) ? issue.rows.join(', ') : issue.row || '—'}</td><td>{issue.key || '—'}</td><td>{(issue.reasons || []).join(' ')}</td></tr>)}</tbody></table>{allIssues.length > 30 && <p>Showing the first 30 issues. Download the review CSV for the full list.</p>}</div>
      </>}
    </section>}

    {credentials.length > 0 && <section className="surface-card bulk-import-summary credential-output">
      <div className="surface-heading"><div><span className="section-kicker">ONE-TIME CREDENTIALS</span><h2>Save these passwords now</h2></div><KeyRound size={18} /></div>
      <p>The shared temporary password is returned only during this import. Each TC must change it at first sign-in, within 24 hours. If you close this page, reset an account from Users & roles.</p>
      <button className="btn btn-primary" type="button" onClick={exportCredentials}><Download size={16} />Download credentials CSV</button>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Name</th><th>Username</th><th>Districts</th><th>Temporary password</th></tr></thead><tbody>{credentials.map((item) => <tr key={item.username}><td>{item.name}</td><td>{item.username}</td><td>{item.districts.join(', ')}</td><td><code>{item.temporaryPassword}</code></td></tr>)}</tbody></table></div>
    </section>}
  </div>;
}
