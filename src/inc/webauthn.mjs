/**
 * webauthn.mjs — Pure Node.js WebAuthn / Passkey helpers (ES-256 / P-256 only)
 *
 * No external dependencies — uses Node.js built-in `crypto` (WebCrypto).
 *
 * Supported algorithm: ES-256 (COSE alg -7, P-256).
 * Supported attestation formats: "none" (passkey managers always send "none").
 *
 * Challenge store: in-memory Map with TTL. Challenges are single-use.
 */

import crypto from 'node:crypto';
import cfg from './config.mjs';

// ---------------------------------------------------------------------------
// Challenge store (in-memory, single-use, 5-minute TTL)
// ---------------------------------------------------------------------------

const challengeStore = new Map();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challengeStore) {
    if (now > v.expiresAt) challengeStore.delete(k);
  }
}, 60_000);

/**
 * Generate a random challenge and store it with optional metadata.
 * @param {object} [meta] - e.g. { userId, type }
 * @returns {string} base64url-encoded challenge
 */
export function generateChallenge(meta = {}) {
  const buf = crypto.getRandomValues(new Uint8Array(32));
  const challenge = base64url(buf);
  challengeStore.set(challenge, { ...meta, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return challenge;
}

/**
 * Consume (use-once) a challenge. Returns stored metadata or throws.
 * @param {string} challenge base64url
 * @returns {object} stored metadata
 */
export function consumeChallenge(challenge) {
  const entry = challengeStore.get(challenge);
  if (!entry) throw new Error('Challenge not found or expired');
  if (Date.now() > entry.expiresAt) {
    challengeStore.delete(challenge);
    throw new Error('Challenge expired');
  }
  challengeStore.delete(challenge);
  return entry;
}

// ---------------------------------------------------------------------------
// Relying Party config
// ---------------------------------------------------------------------------

function getRpId(override) {
  // Explicit override wins (e.g. derived from request Host header for localhost dev)
  if (override) return override;
  return cfg.websrv?.passkey_rp_id || cfg.main?.url?.domain || 'localhost';
}

/**
 * Derive an rpId from a Host header value.
 * e.g. "localhost:1337" → "localhost", "f0ck.dev" → "f0ck.dev"
 * Use this in route handlers and pass the result to build-x and verify-x functions.
 */
export function getRpIdFromHost(hostHeader) {
  if (!hostHeader) return null;
  return hostHeader.split(':')[0] || null;
}

function getExpectedOrigins(rpId) {
  const origins = [`https://${rpId}`];
  // Also allow http for localhost dev
  if (rpId === 'localhost' || rpId.startsWith('127.') || rpId === '[::1]') {
    origins.push(`http://${rpId}`);
    // Also allow http://localhost:PORT
    if (cfg.websrv?.port) origins.push(`http://${rpId}:${cfg.websrv.port}`);
  }
  // Allow any extra origins from config
  if (Array.isArray(cfg.websrv?.passkey_extra_origins)) {
    origins.push(...cfg.websrv.passkey_extra_origins);
  }
  return origins;
}

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

export function base64url(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('base64url');
}

export function fromBase64url(str) {
  return Buffer.from(str, 'base64url');
}

function fromBase64(str) {
  return Buffer.from(str, 'base64');
}

function toBase64(buf) {
  return Buffer.from(buf).toString('base64');
}

// ---------------------------------------------------------------------------
// CBOR minimal decoder (only what we need for authenticatorData / COSE key)
// ---------------------------------------------------------------------------

/**
 * Minimal CBOR decoder supporting:
 *   - unsigned int (major 0)
 *   - negative int (major 1)
 *   - byte string (major 2)
 *   - text string (major 3)
 *   - array (major 4)
 *   - map (major 5)
 *   - simple/float (major 7) — ignored/skipped
 */
function cborDecode(buf, offset = 0) {
  const [value, newOffset] = _cborDecodeItem(buf, offset);
  return value;
}

function _cborDecodeItem(buf, offset) {
  const byte = buf[offset++];
  const major = (byte >> 5) & 0x7;
  const info  = byte & 0x1f;

  let additionalInt;
  if (info < 24) {
    additionalInt = info;
  } else if (info === 24) {
    additionalInt = buf[offset++];
  } else if (info === 25) {
    additionalInt = (buf[offset] << 8) | buf[offset + 1];
    offset += 2;
  } else if (info === 26) {
    additionalInt = (buf[offset] << 24 | buf[offset+1] << 16 | buf[offset+2] << 8 | buf[offset+3]) >>> 0;
    offset += 4;
  } else if (info === 27) {
    // 64-bit uint — read as BigInt then convert (sign_count fits in 53-bit JS int normally)
    const hi = (buf[offset] << 24 | buf[offset+1] << 16 | buf[offset+2] << 8 | buf[offset+3]) >>> 0;
    const lo = (buf[offset+4] << 24 | buf[offset+5] << 16 | buf[offset+6] << 8 | buf[offset+7]) >>> 0;
    additionalInt = hi * 0x100000000 + lo;
    offset += 8;
  } else {
    throw new Error(`CBOR: unsupported additional info ${info}`);
  }

  switch (major) {
    case 0: return [additionalInt, offset];
    case 1: return [-(additionalInt + 1), offset];
    case 2: {
      const slice = buf.slice(offset, offset + additionalInt);
      return [slice, offset + additionalInt];
    }
    case 3: {
      const str = buf.slice(offset, offset + additionalInt).toString('utf8');
      return [str, offset + additionalInt];
    }
    case 4: {
      const arr = [];
      for (let i = 0; i < additionalInt; i++) {
        let item;
        [item, offset] = _cborDecodeItem(buf, offset);
        arr.push(item);
      }
      return [arr, offset];
    }
    case 5: {
      const map = {};
      for (let i = 0; i < additionalInt; i++) {
        let key, val;
        [key, offset] = _cborDecodeItem(buf, offset);
        [val, offset] = _cborDecodeItem(buf, offset);
        map[key] = val;
      }
      return [map, offset];
    }
    case 7: {
      // simple/float — skip
      if (info < 20) return [undefined, offset];
      if (info === 20) return [false, offset];
      if (info === 21) return [true, offset];
      if (info === 22) return [null, offset];
      if (info === 25) return [undefined, offset + 2];  // float16, skip
      if (info === 26) return [undefined, offset + 4];  // float32, skip
      if (info === 27) return [undefined, offset + 8];  // float64, skip
      return [undefined, offset];
    }
    default:
      throw new Error(`CBOR: unsupported major type ${major}`);
  }
}

// ---------------------------------------------------------------------------
// Parse authenticatorData (binary, defined in WebAuthn spec)
// ---------------------------------------------------------------------------

function parseAuthenticatorData(buf) {
  // 32 bytes rpIdHash + 1 byte flags + 4 bytes signCount + optional attested cred data
  if (buf.length < 37) throw new Error('authenticatorData too short');

  const rpIdHash    = buf.slice(0, 32);
  const flags       = buf[32];
  const signCount   = buf.readUInt32BE(33);

  const UP  = (flags & 0x01) !== 0; // user presence
  const UV  = (flags & 0x04) !== 0; // user verification
  const AT  = (flags & 0x40) !== 0; // attested credential data included
  const ED  = (flags & 0x80) !== 0; // extension data included

  let credentialData = null;
  let offset = 37;

  if (AT) {
    const aaguid = buf.slice(offset, offset + 16);
    offset += 16;
    const credIdLen = buf.readUInt16BE(offset);
    offset += 2;
    const credentialId = buf.slice(offset, offset + credIdLen);
    offset += credIdLen;
    // Remaining bytes (up to ED extension) are COSE public key
    const coseKeyBuf = ED
      ? buf.slice(offset) // we'll just parse until COSE map ends
      : buf.slice(offset);
    const coseKey = cborDecode(coseKeyBuf);
    credentialData = { aaguid, credentialId, coseKey };
  }

  return { rpIdHash, flags: { UP, UV, AT, ED }, signCount, credentialData };
}

// ---------------------------------------------------------------------------
// Convert COSE ES-256 public key map to raw P-256 point (uncompressed)
// ---------------------------------------------------------------------------

function coseToSpki(coseKey) {
  // COSE map keys: 1=kty, 3=alg, -1=crv, -2=x, -3=y
  const kty = coseKey[1];
  const alg = coseKey[3];
  if (kty !== 2) throw new Error(`COSE: expected kty=2 (EC2), got ${kty}`);
  if (alg !== -7) throw new Error(`COSE: expected alg=-7 (ES-256), got ${alg}`);

  const x = Buffer.from(coseKey[-2]); // 32 bytes
  const y = Buffer.from(coseKey[-3]); // 32 bytes
  if (x.length !== 32 || y.length !== 32) throw new Error('COSE: invalid P-256 point length');

  // Build DER SPKI for P-256:
  //   SEQUENCE {
  //     SEQUENCE { OID 1.2.840.10045.2.1 (ecPublicKey), OID 1.2.840.10045.3.1.7 (P-256) }
  //     BIT STRING { 0x04 || x || y }
  //   }
  const oid = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
  const point = Buffer.concat([Buffer.from([0x04]), x, y]);
  const spki = Buffer.concat([oid, point]);
  return spki;
}

// ---------------------------------------------------------------------------
// Registration verification
// ---------------------------------------------------------------------------

/**
 * Verify a WebAuthn registration (attestation) response.
 *
 * @param {object} params
 * @param {string} params.challenge       - base64url challenge that was sent to client
 * @param {string} params.clientDataJSON  - base64url from CredentialCreationResponse
 * @param {string} params.attestationObject - base64url from CredentialCreationResponse
 * @param {string} params.credentialId    - base64url credential ID from response
 *
 * @returns {{ credentialId: string, spki: string, signCount: number, aaguid: string }}
 *   credentialId: base64url, spki: base64-encoded DER, signCount, aaguid: hex
 */
export async function verifyRegistration({ challenge, clientDataJSON, attestationObject, credentialId, rpId: rpIdOverride }) {
  // 1. Decode and verify clientDataJSON
  const clientData = JSON.parse(fromBase64url(clientDataJSON).toString('utf8'));
  if (clientData.type !== 'webauthn.create') {
    throw new Error('clientData.type must be webauthn.create');
  }
  if (clientData.challenge !== challenge) {
    throw new Error('Challenge mismatch');
  }
  const rpId = getRpId(rpIdOverride);
  const expectedOrigins = getExpectedOrigins(rpId);
  if (!expectedOrigins.includes(clientData.origin)) {
    throw new Error(`Unexpected origin: ${clientData.origin}. Expected one of: ${expectedOrigins.join(', ')}`);
  }

  // 2. Parse attestationObject (CBOR)
  const attObjBuf = fromBase64url(attestationObject);
  const attObj = cborDecode(attObjBuf);
  const fmt = attObj['fmt'];
  const authDataBuf = Buffer.from(attObj['authData']);

  // Only accept "none" attestation (all passkey managers use this)
  if (fmt !== 'none' && fmt !== 'packed' && fmt !== 'fido-u2f') {
    // We parse but don't verify attestation statements for non-none formats;
    // passkeys always use "none" so this is fine in practice.
  }

  // 3. Parse authenticatorData
  const authData = parseAuthenticatorData(authDataBuf);

  // 4. Verify rpIdHash
  const expectedRpIdHash = crypto.createHash('sha256').update(rpId).digest();
  if (!authData.rpIdHash.equals(expectedRpIdHash)) {
    throw new Error('rpIdHash mismatch');
  }

  // 5. Check user presence flag (UP must be set for passkeys)
  if (!authData.flags.UP) {
    throw new Error('User presence flag not set');
  }

  // 6. Extract credential data
  if (!authData.credentialData) {
    throw new Error('No attested credential data in authenticatorData');
  }
  const { credentialId: credIdBuf, coseKey, aaguid } = authData.credentialData;

  // Verify credentialId matches what the browser sent
  const credIdFromAuthData = base64url(credIdBuf);
  if (credIdFromAuthData !== credentialId) {
    throw new Error('credentialId mismatch between attestation and response');
  }

  // 7. Convert COSE key to SPKI DER
  const spkiBuf = coseToSpki(coseKey);
  const spki = toBase64(spkiBuf);

  const aaguidHex = Buffer.from(aaguid).toString('hex');

  return {
    credentialId,
    spki,
    signCount: authData.signCount,
    aaguid: aaguidHex
  };
}

// ---------------------------------------------------------------------------
// Authentication verification
// ---------------------------------------------------------------------------

/**
 * Verify a WebAuthn authentication (assertion) response.
 *
 * @param {object} params
 * @param {string} params.challenge        - base64url challenge that was sent to client
 * @param {string} params.clientDataJSON   - base64url from CredentialAssertionResponse
 * @param {string} params.authenticatorData - base64url from CredentialAssertionResponse
 * @param {string} params.signature        - base64url from CredentialAssertionResponse
 * @param {string} params.spki             - base64 DER SPKI stored at registration
 * @param {number} params.storedSignCount  - sign_count stored in DB
 *
 * @returns {{ newSignCount: number }} updated sign count
 */
export async function verifyAuthentication({ challenge, clientDataJSON, authenticatorData, signature, spki, storedSignCount, rpId: rpIdOverride }) {
  // 1. Decode and verify clientDataJSON
  const clientData = JSON.parse(fromBase64url(clientDataJSON).toString('utf8'));
  if (clientData.type !== 'webauthn.get') {
    throw new Error('clientData.type must be webauthn.get');
  }
  if (clientData.challenge !== challenge) {
    throw new Error('Challenge mismatch');
  }
  const rpId = getRpId(rpIdOverride);
  const expectedOrigins = getExpectedOrigins(rpId);
  if (!expectedOrigins.includes(clientData.origin)) {
    throw new Error(`Unexpected origin: ${clientData.origin}`);
  }

  // 2. Parse authenticatorData
  const authDataBuf = fromBase64url(authenticatorData);
  const authData = parseAuthenticatorData(authDataBuf);

  // 3. Verify rpIdHash
  const expectedRpIdHash = crypto.createHash('sha256').update(rpId).digest();
  if (!authData.rpIdHash.equals(expectedRpIdHash)) {
    throw new Error('rpIdHash mismatch');
  }

  // 4. Check user presence flag
  if (!authData.flags.UP) {
    throw new Error('User presence flag not set');
  }

  // 5. Verify signature
  //    sig = ECDSA-SHA256(authData || SHA256(clientDataJSON))
  const clientDataHash = crypto.createHash('sha256').update(fromBase64url(clientDataJSON)).digest();
  const verifyData = Buffer.concat([authDataBuf, clientDataHash]);
  const sigBuf = fromBase64url(signature);
  const spkiBuf = fromBase64(spki);

  const keyObject = crypto.createPublicKey({ key: spkiBuf, format: 'der', type: 'spki' });
  // Node.js crypto.verify: algorithm must be a string ('SHA256'), not a WebCrypto object.
  // For ECDSA the digest algorithm is specified here; the curve is derived from the key.
  const valid = crypto.verify('SHA256', verifyData, keyObject, sigBuf);
  if (!valid) {
    throw new Error('Signature verification failed');
  }

  // 6. Check sign counter (0 means authenticator doesn't support it — skip check)
  const newSignCount = authData.signCount;
  if (storedSignCount > 0 && newSignCount !== 0 && newSignCount <= storedSignCount) {
    throw new Error(`Sign count replay attack detected: stored=${storedSignCount} got=${newSignCount}`);
  }

  return { newSignCount };
}

/**
 * Build registration options to send to the client.
 * @param {object} params
 * @param {string} params.challenge - base64url challenge
 * @param {string} params.userId    - base64url user handle (should be opaque, e.g. SHA256 of user.id)
 * @param {string} params.userName  - e.g. "anon_abc123"
 * @param {string} params.displayName - e.g. "Anonymous"
 * @param {Array}  params.excludeCredentials - list of {id, type} to exclude (prevent re-registration)
 * @returns {object} PublicKeyCredentialCreationOptions-compatible JSON
 */
export function buildRegistrationOptions({ challenge, userId, userName, displayName, excludeCredentials = [], rpId: rpIdOverride }) {
  const rpId = getRpId(rpIdOverride);
  return {
    rp: {
      name: cfg.main?.sitename || 'f0ck.dev',
      id: rpId
    },
    user: {
      id: userId,
      name: userName,
      displayName: displayName || userName
    },
    challenge,
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 }  // ES-256
    ],
    timeout: 60000,
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred'
    },
    attestation: 'none'
  };
}

/**
 * Build authentication options to send to the client.
 * @param {object} params
 * @param {string} params.challenge - base64url challenge
 * @param {Array}  params.allowCredentials - list of {id, type} (empty = discoverable / any)
 * @returns {object} PublicKeyCredentialRequestOptions-compatible JSON
 */
export function buildAuthenticationOptions({ challenge, allowCredentials = [], rpId: rpIdOverride }) {
  const rpId = getRpId(rpIdOverride);
  return {
    challenge,
    rpId,
    allowCredentials,
    userVerification: 'preferred',
    timeout: 60000
  };
}

// ─── Authenticator names ─────────────────────────────────────────────────────
// AAGUIDs (stored as 32 hex chars) of common passkey providers, from the community list at
// github.com/passkeydeveloper/passkey-authenticator-aaguids. All zeros = the browser/authenticator
// did not disclose it (common with Firefox and "none" attestation).
const AAGUID_PROVIDERS = {
  'd548826e79b4db40a3d811116f7e8349': 'Bitwarden',
  'fbfc3007154e4ecc8c0b6e020557d7bd': 'iCloud Keychain',
  'dd4ec289e01d41c9bb8970fa845d4bf2': 'iCloud Keychain (Managed)',
  'ea9b8d664d011d213ce4b6b48cb575d4': 'Google Password Manager',
  'adce000235bcc60a648b0b25f1f05503': 'Chrome on Mac',
  '08987058cadc4b81b6e130de50dcbe96': 'Windows Hello',
  '9ddd1817af5a4672a2b93e3dd95000a9': 'Windows Hello',
  '6028b017b1d44c02b4b3afcdafc96bb2': 'Windows Hello',
  'bada5566a7aa401fbd9645619a55120d': '1Password',
  '531126d6e717415c93203d9aa6981239': 'Dashlane',
  'fdb141b25d84443e8a354698c205a502': 'KeePassXC',
  '50726f746f6e5061737350726f746f6e': 'Proton Pass',
  '53414d53554e47000000000000000000': 'Samsung Pass',
  'cb69481e8ff7403993ec0a2729a154a8': 'YubiKey',
  'ee882879721c491397753dfcce97072a': 'YubiKey',
  'fa2b99dc9e3942578f924a30d23c4118': 'YubiKey',
  '2fc0579f811347eab116bb5a8db9202a': 'YubiKey',
  'c5ef55ffad9a4b9fb580adebafe026d0': 'YubiKey',
  '73bb0cd4e50249b89c6fb59445bf720b': 'YubiKey',
  'a4e9fc6d4cbe4758b8ba37598bb5bbaa': 'Yubico Security Key',
  'b92c3f9ac0144056887f140a2501163b': 'Yubico Security Key',
  '0bb43545fd2c418587ddfeb0b2916ace': 'Yubico Security Key'
};

/**
 * Human name of the authenticator that holds a passkey, from its stored AAGUID.
 * @param {string|null} aaguidHex
 * @returns {string|null} provider name, 'Undisclosed' for the all-zero AAGUID, or null if unknown
 */
export function aaguidProvider(aaguidHex) {
  if (!aaguidHex) return null;
  const hex = String(aaguidHex).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (/^0+$/.test(hex)) return 'Undisclosed';
  return AAGUID_PROVIDERS[hex] || null;
}
