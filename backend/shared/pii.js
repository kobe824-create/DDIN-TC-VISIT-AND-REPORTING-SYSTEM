const crypto = require('node:crypto');

const ENCRYPTED_FIELDS = new Set(['nationalIdEncrypted', 'nextOfKinNameEncrypted', 'nextOfKinPhoneEncrypted']);

function encryptionKey() {
  const key = Buffer.from(process.env.PII_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('PII_ENCRYPTION_KEY must contain a base64-encoded 32-byte key.');
  return key;
}

function encryptPii(value) {
  const plaintext = String(value ?? '').trim();
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptPii(value) {
  if (!value) return null;
  const [version, ivText, tagText, ciphertextText] = String(value).split(':');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) throw new Error('Stored personal data has an unsupported encrypted format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64')), decipher.final()]).toString('utf8');
}

function stripEncryptedPii(value) {
  if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) value[index] = stripEncryptedPii(value[index]);
    return value;
  }
  for (const key of Object.keys(value)) {
    if (ENCRYPTED_FIELDS.has(key)) delete value[key];
    else value[key] = stripEncryptedPii(value[key]);
  }
  return value;
}

function addPiiResponseSanitizer(app) {
  app.use((_req, res, next) => {
    const sendJson = res.json.bind(res);
    res.json = (body) => sendJson(stripEncryptedPii(body));
    next();
  });
}

module.exports = { addPiiResponseSanitizer, decryptPii, encryptPii };
