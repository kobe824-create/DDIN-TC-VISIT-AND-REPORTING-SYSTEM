const zlib = require('zlib');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 50000;
const MAX_COLUMNS = 64;

function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attributes(fragment) {
  const output = {};
  for (const match of fragment.matchAll(/([\w:.-]+)="([^"]*)"/g)) output[match[1]] = decodeXml(match[2]);
  return output;
}

function columnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) return -1;
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function readZipEntries(buffer) {
  const floor = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('This is not a valid .xlsx workbook.');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('The workbook archive is damaged.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLength).replace(/\\/g, '/');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const contentOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(contentOffset, contentOffset + compressedSize);
    let contents;
    if (method === 0) contents = compressed;
    else if (method === 8) contents = zlib.inflateRawSync(compressed);
    else throw new Error(`Unsupported workbook compression method: ${method}.`);
    files.set(fileName, contents);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return files;
}

function textRuns(fragment) {
  return [...String(fragment || '').matchAll(/<(?:[\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g)]
    .map((match) => decodeXml(match[1])).join('');
}

function readXlsx(buffer) {
  if (buffer.length > MAX_FILE_BYTES) throw new Error('The spreadsheet is too large. Maximum file size is 8 MB.');
  const files = readZipEntries(buffer);
  const workbookXml = files.get('xl/workbook.xml')?.toString('utf8') || '';
  const relsXml = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const firstSheet = workbookXml.match(/<sheet\b([^>]*)\/?\s*>/);
  const relationshipId = firstSheet && attributes(firstSheet[1])['r:id'];
  const relationship = relationshipId && [...relsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)]
    .map((match) => attributes(match[1])).find((item) => item.Id === relationshipId);
  const target = relationship?.Target || 'worksheets/sheet1.xml';
  const worksheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const worksheetXml = files.get(worksheetPath)?.toString('utf8');
  if (!worksheetXml) throw new Error('The first worksheet could not be read.');

  const stringsXml = files.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const sharedStrings = [...stringsXml.matchAll(/<(?:[\w.-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?si>/g)]
    .map((match) => textRuns(match[1]));
  const rowMap = new Map();
  for (const rowMatch of worksheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowAttrs = attributes(rowMatch[1]);
    const rowNumber = Number.parseInt(rowAttrs.r, 10);
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) continue;
    const values = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cellAttrs = attributes(cellMatch[1]);
      const index = columnIndex(cellAttrs.r);
      if (index < 0 || index >= MAX_COLUMNS) continue;
      const body = cellMatch[2] || '';
      const valueMatch = body.match(/<(?:[\w.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v>/);
      let value = valueMatch ? decodeXml(valueMatch[1]) : '';
      if (cellAttrs.t === 's') value = sharedStrings[Number.parseInt(value, 10)] ?? '';
      else if (cellAttrs.t === 'inlineStr') value = textRuns(body);
      else if (cellAttrs.t === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
      values[index] = value;
    }
    rowMap.set(rowNumber, values);
    if (rowMap.size > MAX_ROWS) throw new Error('The spreadsheet has more than 50,000 rows.');
  }
  const ordered = [...rowMap.entries()].sort(([a], [b]) => a - b);
  return ordered.map(([rowNumber, values]) => ({ rowNumber, values }));
}

function readCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      if (row.some((value) => value.trim())) rows.push({ rowNumber: rows.length + 1, values: row });
      row = [];
      if (rows.length > MAX_ROWS) throw new Error('The spreadsheet has more than 50,000 rows.');
    } else field += character;
  }
  if (quoted) throw new Error('The CSV has an unfinished quoted field.');
  if (field.length || row.length) {
    row.push(field);
    if (row.some((value) => value.trim())) rows.push({ rowNumber: rows.length + 1, values: row });
  }
  return rows;
}

function parseTabularUpload({ fileName, fileBase64 }) {
  if (typeof fileBase64 !== 'string' || !fileBase64) throw new Error('Choose a spreadsheet to import.');
  if (fileBase64.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 16) throw new Error('The spreadsheet is too large. Maximum file size is 8 MB.');
  const bytes = Buffer.from(fileBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('The spreadsheet is empty or too large.');
  const extension = String(fileName || '').split('.').pop().toLowerCase();
  if (extension === 'xlsx') {
    const workbookRows = readXlsx(bytes);
    if (!workbookRows.length) throw new Error('The first worksheet is empty.');
    return workbookRows;
  }
  if (extension === 'csv') return readCsv(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  throw new Error('Use an .xlsx or .csv file.');
}

module.exports = { parseTabularUpload, decodeXml };
