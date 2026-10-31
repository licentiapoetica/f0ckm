import crypto from 'node:crypto';
import db from './sql.mjs';
import lib from './lib.mjs';
import cfg from './config.mjs';

import security from './security.mjs';

/**
 * IP of the request in its storable form (see security.storableIP): null when IP logging is off.
 * @param {object} req
 * @returns {string|null}
 */
export function resolveAuditIP(req) {
  if (!req) return null;
  return security.storableIP(security.getRealIP(req));
}

/**
 * Log activity for an anonymous user (or session).
 * @param {object} req
 * @param {{ action: string, targetId?: number|string, details?: object, hwFingerprint?: string }} params
 */
export async function logAnonActivity(req, { action, targetId = null, details = null, hwFingerprint = null } = {}) {
  try {
    const rawIp = security.getRealIP(req);
    const ip = security.storableIP(rawIp);
    const userId = req?.session?.id || null;
    if (!userId) return;
    const fingerprint = req?.session?.fingerprint || req?.session?.anon_fingerprint || null;
    const hwFp = hwFingerprint || req?.session?.hw_fingerprint || null;
    const numTargetId = targetId ? parseInt(targetId, 10) : null;

    await db`
      INSERT INTO anon_activity_log (user_id, fingerprint, hw_fingerprint, ip, action, target_id, details)
      VALUES (${userId}, ${fingerprint}, ${hwFp}, ${ip}, ${action}, ${!isNaN(numTargetId) ? numTargetId : null}, ${details ? JSON.stringify(details) : null})
    `;

    await security.logUserIP(userId, rawIp);
  } catch (err) {
    console.error('[ANON_ACTIVITY_LOG] Failed to log activity:', err);
  }
}

/**
 * Find or create a shadow user in the database for a passkey-authenticated anonymous identity.
 *
 * @param {string} credentialId  - base64url WebAuthn credential ID
 * @param {object} [req]
 * @param {string} [hwFingerprint]
 * @returns {Promise<{ userId: number, isNew: boolean, fingerprint: string }>}
 */
export async function getOrCreateAnonUserByCredential(credentialId, req = null, hwFingerprint = null) {
  const auditIp = req ? resolveAuditIP(req) : null;

  // Derive a stable "fingerprint" from the credential ID (for ban checks / display)
  const fpBytes = crypto.createHash('sha256').update(Buffer.from(credentialId)).digest();
  const fingerprint = 'SHA256:' + fpBytes.toString('base64').replace(/=+$/, '');

  // Check if we already have a row for this credential
  const existing = await db`
    SELECT user_id FROM anon_identities
    WHERE credential_id = ${credentialId}
    LIMIT 1
  `;

  if (existing.length > 0) {
    await db`
      UPDATE anon_identities
      SET last_seen = NOW()
          ${auditIp ? db`, last_ip = ${auditIp}` : db``}
          ${hwFingerprint ? db`, hw_fingerprint = ${hwFingerprint}` : db``}
      WHERE credential_id = ${credentialId}
    `.catch(() => {});
    return { userId: existing[0].user_id, isNew: false, fingerprint };
  }

  // Generate unique shadow username based on fingerprint short hash
  const shortHash = fpBytes.toString('hex').slice(0, 8);
  let baseLogin = `anon_${shortHash}`;
  let finalLogin = baseLogin;
  let counter = 1;

  while (true) {
    const check = await db`SELECT id FROM "user" WHERE login = ${finalLogin} LIMIT 1`;
    if (check.length === 0) break;
    finalLogin = `${baseLogin}_${counter++}`;
  }

  const userRows = await db`
    INSERT INTO "user" (login, "user", password, admin, is_moderator, activated)
    VALUES (${finalLogin}, ${finalLogin}, '!', false, false, true)
    RETURNING id
  `;
  const userId = userRows[0].id;

  await db`
    INSERT INTO user_options (user_id, mode, theme, fullscreen, avatar, display_name, use_alternative_infobox)
    VALUES (${userId}, 0, 'amoled', 0, null, 'Anonymous', ${cfg.websrv.user_alternative_infobox !== false})
    ON CONFLICT (user_id) DO NOTHING
  `;

  await db`
    INSERT INTO anon_identities (user_id, credential_id, fingerprint, created_ip, last_ip, hw_fingerprint)
    VALUES (${userId}, ${credentialId}, ${fingerprint}, ${auditIp}, ${auditIp}, ${hwFingerprint})
    ON CONFLICT (credential_id) DO UPDATE
    SET last_seen = NOW()
        ${auditIp ? db`, last_ip = ${auditIp}` : db``}
        ${hwFingerprint ? db`, hw_fingerprint = ${hwFingerprint}` : db``}
  `;

  return { userId, isNew: true, fingerprint };
}

/**
 * Create a valid session in user_sessions for an anonymous user.
 * @param {number} userId
 * @param {object} req
 * @param {string} [hwFingerprint]
 * @returns {Promise<{ session: string, csrf_token: string }>}
 */
export async function createAnonSession(userId, req, hwFingerprint = null, credentialId = null) {
  const auditIp = resolveAuditIP(req);

  // Update anon_identities last_ip and hw_fingerprint
  await db`
    UPDATE anon_identities
    SET last_ip = ${auditIp},
        created_ip = COALESCE(created_ip, ${auditIp})
        ${hwFingerprint ? db`, hw_fingerprint = COALESCE(${hwFingerprint}, hw_fingerprint)` : db``}
    WHERE user_id = ${userId}
  `.catch(() => {});

  // Remember which passkey this session runs on (settings: can't delete the one in use)
  const markCredential = async (sessionHash) => {
    if (!credentialId) return;
    await db`UPDATE user_sessions SET passkey_credential_id = ${credentialId} WHERE session = ${sessionHash}`.catch(() => {});
  };

  // If req.session is already active for this exact userId, reuse it
  if (req?.session && req.session.id === userId && req.session.csrf_token && req.cookies?.session) {
    await markCredential(lib.sha256(req.cookies.session));
    await logAnonActivity(req, { action: 'handshake', hwFingerprint });
    return { session: req.cookies.session, csrf_token: req.session.csrf_token };
  }

  // If client has a session cookie that maps to this userId in DB, reuse it
  if (req?.cookies?.session) {
    const existingHash = lib.sha256(req.cookies.session);
    const existing = await db`
      SELECT session, csrf_token FROM user_sessions
      WHERE user_id = ${userId} AND session = ${existingHash}
      LIMIT 1
    `;
    if (existing.length > 0) {
      await db`UPDATE user_sessions SET last_used = ${~~(Date.now() / 1e3)} WHERE session = ${existingHash}`;
      await markCredential(existingHash);
      await logAnonActivity({ ...req, session: { id: userId, is_anon: true } }, { action: 'handshake', hwFingerprint });
      return { session: req.cookies.session, csrf_token: existing[0].csrf_token };
    }
  }

  const session = crypto.randomBytes(32).toString('hex');
  const sessionHash = lib.sha256(session);
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const stamp = ~~(Date.now() / 1e3);
  const ip = auditIp;
  const ua = req?.headers ? (req.headers['user-agent'] || '') : '';

  const sessRecord = {
    user_id: userId,
    session: sessionHash,
    csrf_token: csrfToken,
    browser: ua,
    created_at: stamp,
    last_used: stamp,
    last_action: '/anon/passkey/auth',
    kmsi: 1,
    ip: ip
  };

  await db`
    INSERT INTO "user_sessions" ${db(sessRecord, 'user_id', 'session', 'csrf_token', 'browser', 'created_at', 'last_used', 'last_action', 'kmsi', 'ip')}
  `;
  await markCredential(sessionHash);

  await logAnonActivity({ ...req, session: { id: userId, is_anon: true } }, { action: 'handshake', hwFingerprint });

  return { session, csrf_token: csrfToken };
}
