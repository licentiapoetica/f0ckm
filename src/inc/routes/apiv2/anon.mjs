import crypto from 'node:crypto';
import db from '../../sql.mjs';
import lib from '../../lib.mjs';
import cfg from '../../config.mjs';
import security from '../../security.mjs';
import {
  getOrCreateAnonUserByCredential,
  createAnonSession,
  resolveAuditIP
} from '../../anon_auth.mjs';
import {
  generateChallenge, consumeChallenge,
  verifyRegistration, verifyAuthentication,
  buildRegistrationOptions, buildAuthenticationOptions,
  base64url, fromBase64url, getRpIdFromHost, aaguidProvider
} from '../../webauthn.mjs';
import { getEnableAnonymousAccess, getHwFingerprintEnabled } from '../../settings.mjs';

// Maximum number of passkeys a single anonymous identity may hold
const MAX_ANON_PASSKEYS = 4;

const countPasskeys = async userId => {
  const rows = await db`SELECT COUNT(*)::int AS n FROM passkey_credentials WHERE user_id = ${userId}`;
  return rows[0]?.n || 0;
};

export default router => {
  router.group(/^\/api\/v2\/anon/, group => {

    // ─── Helpers ─────────────────────────────────────────────────────────────

    const formatCascadeReason = (sourceReason, prefix = 'Cascade ban from device') => {
      if (!sourceReason) return prefix;
      let clean = sourceReason;
      while (/^Cascade ban from (device|hardware ID|key) \((.*)\)$/.test(clean)) {
        clean = clean.replace(/^Cascade ban from (device|hardware ID|key) \((.*)\)$/, '$2');
      }
      return `${prefix} (${clean || 'Violation of community rules'})`;
    };

    // Client-supplied device fingerprint, or null when fingerprinting is disabled (then nothing is stored or matched)
    const acceptHw = (hw) => (getHwFingerprintEnabled() && hw) ? String(hw).slice(0, 128) : null;
    const acceptTombstone = (t) => (t && !getHwFingerprintEnabled()) ? { ...t, hw_fingerprint: null } : t;

    const setBanCookie = (res, reason, expires) => {
      const payload = encodeURIComponent(JSON.stringify({
        banned: true,
        reason: reason || 'Banned',
        expires: expires ? new Date(expires).toISOString() : null
      }));
      res.setHeader('Set-Cookie', `f0ck_banned=${payload}; Path=/; Max-Age=31536000; SameSite=Lax`);
    };

    const checkAndCascadeBans = async (res, fingerprint, hwFingerprint, credentialId, tombstone) => {
      // Tombstone cascade
      if (tombstone && tombstone.banned) {
        const tombstoneFp = tombstone.fingerprint;
        const tombstoneHw = tombstone.hw_fingerprint;
        const tombstoneBan = tombstoneFp ? await security.isFingerprintBanned(tombstoneFp) : null;
        const tombstoneHwBan = (!tombstoneBan && tombstoneHw) ? await security.isHardwareBanned(tombstoneHw) : null;
        const activeTombstoneBan = tombstoneBan || tombstoneHwBan;
        if (activeTombstoneBan) {
          const alreadyFpBanned = fingerprint ? await security.isFingerprintBanned(fingerprint) : false;
          if (!alreadyFpBanned && fingerprint) {
            await security.banAnonymousUser({
              fingerprint,
              hwFingerprint: hwFingerprint || tombstoneHw,
              bannedBy: activeTombstoneBan.banned_by,
              reason: formatCascadeReason(activeTombstoneBan.reason, 'Cascade ban from device'),
              expires: activeTombstoneBan.expires,
              banIps: true,
              banHardware: true
            });
          }
          return activeTombstoneBan;
        }
      }

      // Hardware fingerprint ban
      if (hwFingerprint) {
        const hwBan = await security.isHardwareBanned(hwFingerprint);
        if (hwBan) {
          const alreadyFpBanned = fingerprint ? await security.isFingerprintBanned(fingerprint) : false;
          if (!alreadyFpBanned && fingerprint) {
            await security.banAnonymousUser({
              fingerprint,
              hwFingerprint,
              bannedBy: hwBan.banned_by,
              reason: formatCascadeReason(hwBan.reason, 'Cascade ban from hardware ID'),
              expires: hwBan.expires,
              banIps: true,
              banHardware: true
            });
          }
          return hwBan;
        }
      }

      // Fingerprint ban
      if (fingerprint) {
        const fpBan = await security.isFingerprintBanned(fingerprint);
        if (fpBan) {
          if (hwFingerprint) {
            const alreadyHwBanned = await security.isHardwareBanned(hwFingerprint);
            if (!alreadyHwBanned) {
              await security.banAnonymousUser({
                fingerprint,
                hwFingerprint,
                bannedBy: fpBan.banned_by,
                reason: formatCascadeReason(fpBan.reason, 'Cascade ban from key'),
                expires: fpBan.expires,
                banIps: true,
                banHardware: true
              });
            }
          }
          return fpBan;
        }
      }

      return null;
    };

    // ─── Deprecated SSH endpoint — hard cut ───────────────────────────────────

    group.post(/\/session$/, async (req, res) => {
      return res.json({
        success: false,
        msg: 'SSH-key anonymous authentication has been replaced by passkeys. Please refresh the page.'
      }, 410);
    });

    // ─── Passkey Registration ─────────────────────────────────────────────────

    /**
     * POST /api/v2/anon/passkey/register/begin
     * Returns WebAuthn registration options (challenge + rp + user config).
     * The client does NOT need to be logged in.
     */
    group.post(/\/passkey\/register\/begin$/, async (req, res) => {
      try {
        if (!getEnableAnonymousAccess()) {
          return res.json({ success: false, msg: 'Anonymous access is disabled' }, 403);
        }

        const clientIp = security.getRealIP(req);
        const ipBan = await security.isIpBanned(clientIp);
        if (ipBan) {
          setBanCookie(res, ipBan.reason || 'IP address is banned', ipBan.expires);
          return res.json({ success: false, banned: true, msg: 'YOU ARE BANNED!', reason: ipBan.reason, redirect: '/banned' }, 403);
        }

        const challenge = generateChallenge({ type: 'anon-register' });

        // Generate a temporary opaque user handle (32 random bytes, base64url)
        // This will be replaced by the real user_id after finish, but WebAuthn requires
        // a user.id at registration time. We store it in the challenge.
        const userHandle = base64url(Buffer.from(crypto.getRandomValues(new Uint8Array(16))));
        // Store the user handle in the challenge so finish can retrieve it
        // (The challenge entry is keyed by challenge string)
        // We re-issue the challenge with the user handle attached
        const challengeWithHandle = generateChallenge({ type: 'anon-register', userHandle });

        // Temporary display name for the registration prompt
        const tmpName = `anon_new@${cfg.main?.url?.domain || 'f0ck.dev'}`;

        const options = buildRegistrationOptions({
          challenge: challengeWithHandle,
          userId: userHandle,
          userName: tmpName,
          displayName: 'Anonymous',
          rpId: getRpIdFromHost(req.headers.host)
        });

        return res.json({ success: true, options });
      } catch (err) {
        console.error('[ANON_PASSKEY] register/begin error:', err);
        return res.json({ success: false, msg: err.message || 'Internal server error' }, 500);
      }
    });

    /**
     * POST /api/v2/anon/passkey/register/finish
     * Verify attestation, create shadow user + credential, establish session.
     */
    group.post(/\/passkey\/register\/finish$/, async (req, res) => {
      try {
        if (!getEnableAnonymousAccess()) {
          return res.json({ success: false, msg: 'Anonymous access is disabled' }, 403);
        }

        const clientIp = security.getRealIP(req);
        const ipBan = await security.isIpBanned(clientIp);
        if (ipBan) {
          setBanCookie(res, ipBan.reason || 'IP address is banned', ipBan.expires);
          return res.json({ success: false, banned: true, msg: 'YOU ARE BANNED!', reason: ipBan.reason, redirect: '/banned' }, 403);
        }

        const body = req.post || req.body || {};
        const { challenge, clientDataJSON, attestationObject, credentialId, hw_fingerprint: rawHw, tombstone: rawTombstone } = body;
        const hwFingerprint = acceptHw(rawHw);
        const tombstone = acceptTombstone(rawTombstone);

        if (!challenge || !clientDataJSON || !attestationObject || !credentialId) {
          return res.json({ success: false, msg: 'Missing required WebAuthn fields' }, 400);
        }

        // Consume and verify challenge
        let challengeMeta;
        try {
          challengeMeta = consumeChallenge(challenge);
        } catch (e) {
          return res.json({ success: false, msg: 'Challenge expired or invalid' }, 400);
        }
        if (challengeMeta.type !== 'anon-register') {
          return res.json({ success: false, msg: 'Wrong challenge type' }, 400);
        }

        // Verify the attestation
        let regResult;
        try {
          regResult = await verifyRegistration({ challenge, clientDataJSON, attestationObject, credentialId, rpId: getRpIdFromHost(req.headers.host) });
        } catch (e) {
          console.warn('[ANON_PASSKEY] Registration verification failed:', e.message);
          return res.json({ success: false, msg: `Registration failed: ${e.message}` }, 400);
        }

        // Get fingerprint before ban checks (derived from credentialId)
        const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(credentialId)).digest().toString('base64').replace(/=+$/, '');

        // Ban checks
        const ban = await checkAndCascadeBans(res, fingerprint, hwFingerprint || null, credentialId, tombstone || null);
        if (ban) {
          setBanCookie(res, ban.reason || 'Banned', ban.expires);
          return res.json({
            success: false, banned: true,
            fingerprint, hw_fingerprint: hwFingerprint,
            msg: 'YOU ARE BANNED!', reason: ban.reason,
            expires: ban.expires ? new Date(ban.expires).toLocaleString() : 'Permanent',
            redirect: '/banned'
          }, 403);
        }

        // Get or create shadow user
        const { userId, isNew, fingerprint: fp } = await getOrCreateAnonUserByCredential(
          credentialId, req, hwFingerprint || null
        );

        // Check user table ban
        const userRows = await db`SELECT banned, ban_reason, ban_expires, activated FROM "user" WHERE id = ${userId} LIMIT 1`;
        if (userRows.length > 0 && userRows[0].activated === false) {
          return res.json({ success: false, msg: 'This account is not activated. Please check your email.' }, 403);
        }
        if (userRows.length > 0 && userRows[0].banned) {
          const u = userRows[0];
          setBanCookie(res, u.ban_reason || 'Banned', u.ban_expires);
          return res.json({ success: false, banned: true, msg: 'YOU ARE BANNED!', reason: u.ban_reason, redirect: '/banned' }, 403);
        }

        // Store / update passkey credential in passkey_credentials
        await db`
          INSERT INTO passkey_credentials (user_id, credential_id, public_key_spki, sign_count, aaguid, name)
          VALUES (${userId}, ${credentialId}, ${regResult.spki}, ${regResult.signCount}, ${regResult.aaguid || null}, ${'Passkey'})
          ON CONFLICT (credential_id) DO UPDATE
          SET sign_count = ${regResult.signCount}, last_used = NOW()
        `;

        const { session, csrf_token } = await createAnonSession(userId, req, hwFingerprint || null, credentialId);
        res.setHeader('Set-Cookie', `session=${session}; ${lib.getCookieOptions('Fri, 31 Dec 9999 23:59:59 GMT')}`);

        return res.json({
          success: true,
          is_new: isNew,
          user_id: userId,
          fingerprint: fp,
          short_fingerprint: fp.slice(7, 15),
          credential_id: credentialId,
          hw_fingerprint: hwFingerprint || null,
          csrf_token
        });
      } catch (err) {
        console.error('[ANON_PASSKEY] register/finish error:', err);
        return res.json({ success: false, msg: err.message || 'Internal server error' }, 500);
      }
    });

    // ─── Passkey Authentication ───────────────────────────────────────────────

    /**
     * POST /api/v2/anon/passkey/auth/begin
     * Returns authentication options. allowCredentials is empty (discoverable credential flow).
     */
    group.post(/\/passkey\/auth\/begin$/, async (req, res) => {
      try {
        if (!getEnableAnonymousAccess()) {
          return res.json({ success: false, msg: 'Anonymous access is disabled' }, 403);
        }

        const clientIp = security.getRealIP(req);
        const ipBan = await security.isIpBanned(clientIp);
        if (ipBan) {
          setBanCookie(res, ipBan.reason || 'IP address is banned', ipBan.expires);
          return res.json({ success: false, banned: true, msg: 'YOU ARE BANNED!', reason: ipBan.reason, redirect: '/banned' }, 403);
        }

        const challenge = generateChallenge({ type: 'anon-auth' });
        const options = buildAuthenticationOptions({
          challenge,
          allowCredentials: [], // discoverable — let the browser/Bitwarden pick
          rpId: getRpIdFromHost(req.headers.host)
        });

        return res.json({ success: true, options });
      } catch (err) {
        console.error('[ANON_PASSKEY] auth/begin error:', err);
        return res.json({ success: false, msg: err.message || 'Internal server error' }, 500);
      }
    });

    /**
     * POST /api/v2/anon/passkey/auth/finish
     * Verify assertion, establish anonymous session.
     */
    group.post(/\/passkey\/auth\/finish$/, async (req, res) => {
      try {
        if (!getEnableAnonymousAccess()) {
          return res.json({ success: false, msg: 'Anonymous access is disabled' }, 403);
        }

        const clientIp = security.getRealIP(req);
        const ipBan = await security.isIpBanned(clientIp);
        if (ipBan) {
          setBanCookie(res, ipBan.reason || 'IP address is banned', ipBan.expires);
          return res.json({ success: false, banned: true, msg: 'YOU ARE BANNED!', reason: ipBan.reason, redirect: '/banned' }, 403);
        }

        const body = req.post || req.body || {};
        const { challenge, clientDataJSON, authenticatorData, signature, credentialId, hw_fingerprint: rawHw, tombstone: rawTombstone } = body;
        const hwFingerprint = acceptHw(rawHw);
        const tombstone = acceptTombstone(rawTombstone);

        if (!challenge || !clientDataJSON || !authenticatorData || !signature || !credentialId) {
          return res.json({ success: false, msg: 'Missing required WebAuthn fields' }, 400);
        }

        // Consume challenge
        let challengeMeta;
        try {
          challengeMeta = consumeChallenge(challenge);
        } catch (e) {
          return res.json({ success: false, msg: 'Challenge expired or invalid' }, 400);
        }
        if (challengeMeta.type !== 'anon-auth') {
          return res.json({ success: false, msg: 'Wrong challenge type' }, 400);
        }

        // Look up stored credential
        const credRows = await db`
          SELECT pc.user_id, pc.public_key_spki, pc.sign_count, ai.fingerprint
          FROM passkey_credentials pc
          LEFT JOIN anon_identities ai ON ai.user_id = pc.user_id AND ai.credential_id = ${credentialId}
          WHERE pc.credential_id = ${credentialId}
          LIMIT 1
        `;

        if (credRows.length === 0) {
          return res.json({ success: false, msg: 'Passkey not registered. Please register first.' }, 401);
        }

        const { user_id: userId, public_key_spki: spki, sign_count: storedSignCount, fingerprint } = credRows[0];

        // Verify the assertion
        let authResult;
        try {
          authResult = await verifyAuthentication({
            challenge,
            clientDataJSON,
            authenticatorData,
            signature,
            spki,
            storedSignCount,
            rpId: getRpIdFromHost(req.headers.host)
          });
        } catch (e) {
          console.warn('[ANON_PASSKEY] Auth verification failed:', e.message);
          return res.json({ success: false, msg: `Authentication failed: ${e.message}` }, 401);
        }

        // Derive fingerprint if not stored yet (legacy or first-time)
        const fpForBan = fingerprint || (() => {
          return 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(credentialId)).digest().toString('base64').replace(/=+$/, '');
        })();

        // Ban checks
        const ban = await checkAndCascadeBans(res, fpForBan, hwFingerprint || null, credentialId, tombstone || null);
        if (ban) {
          setBanCookie(res, ban.reason || 'Banned', ban.expires);
          return res.json({
            success: false, banned: true,
            fingerprint: fpForBan, hw_fingerprint: hwFingerprint,
            msg: 'YOU ARE BANNED!', reason: ban.reason,
            expires: ban.expires ? new Date(ban.expires).toLocaleString() : 'Permanent',
            redirect: '/banned'
          }, 403);
        }

        // Check user table ban
        const userRows = await db`SELECT banned, ban_reason, ban_expires, activated FROM "user" WHERE id = ${userId} LIMIT 1`;
        if (userRows.length > 0 && userRows[0].activated === false) {
          return res.json({ success: false, msg: 'This account is not activated. Please check your email.' }, 403);
        }
        if (userRows.length > 0 && userRows[0].banned) {
          const u = userRows[0];
          setBanCookie(res, u.ban_reason || 'Banned', u.ban_expires);
          return res.json({ success: false, banned: true, msg: 'YOU ARE BANNED!', reason: u.ban_reason, redirect: '/banned' }, 403);
        }

        // Update sign count and last_used
        await db`
          UPDATE passkey_credentials
          SET sign_count = ${authResult.newSignCount}, last_used = NOW()
          WHERE credential_id = ${credentialId}
        `;

        // Update anon_identities (hw_fingerprint, last_seen)
        await db`
          UPDATE anon_identities
          SET last_seen = NOW()
              ${hwFingerprint ? db`, hw_fingerprint = ${hwFingerprint}` : db``}
          WHERE user_id = ${userId} AND credential_id = ${credentialId}
        `.catch(() => {});

        const { session, csrf_token } = await createAnonSession(userId, req, hwFingerprint || null, credentialId);
        res.setHeader('Set-Cookie', `session=${session}; ${lib.getCookieOptions('Fri, 31 Dec 9999 23:59:59 GMT')}`);

        return res.json({
          success: true,
          user_id: userId,
          fingerprint: fpForBan,
          short_fingerprint: fpForBan.slice(7, 15),
          credential_id: credentialId,
          hw_fingerprint: hwFingerprint || null,
          csrf_token
        });
      } catch (err) {
        console.error('[ANON_PASSKEY] auth/finish error:', err);
        return res.json({ success: false, msg: err.message || 'Internal server error' }, 500);
      }
    });

    // ─── Add Passkey to current anonymous identity ────────────────────────────

    // Resolves the logged-in anonymous user, or null if the session isn't an anon identity
    const getAnonSessionUserId = async req => {
      if (!req.session?.id) return null;
      const rows = await db`SELECT 1 FROM anon_identities WHERE user_id = ${req.session.id} LIMIT 1`;
      return rows.length > 0 ? req.session.id : null;
    };

    /**
     * POST /api/v2/anon/passkey/add/begin
     * Registration options for an additional passkey on the current anonymous identity.
     */
    group.post(/\/passkey\/add\/begin$/, async (req, res) => {
      try {
        if (!getEnableAnonymousAccess()) {
          return res.json({ success: false, msg: 'Anonymous access is disabled' }, 403);
        }

        const userId = await getAnonSessionUserId(req);
        if (!userId) {
          return res.json({ success: false, msg: 'Not logged in as anonymous' }, 401);
        }

        const existing = await db`SELECT credential_id FROM passkey_credentials WHERE user_id = ${userId}`;
        if (existing.length >= MAX_ANON_PASSKEYS) {
          return res.json({ success: false, msg: `You can have at most ${MAX_ANON_PASSKEYS} passkeys.` }, 400);
        }

        const userHandle = base64url(Buffer.from(crypto.getRandomValues(new Uint8Array(16))));
        const challenge = generateChallenge({ type: 'anon-add', userId });

        const options = buildRegistrationOptions({
          challenge,
          userId: userHandle,
          userName: `anon@${cfg.main?.url?.domain || 'f0ck.dev'}`,
          displayName: 'Anonymous',
          rpId: getRpIdFromHost(req.headers.host)
        });
        // Stop the authenticator from registering a second copy of a passkey it already holds
        options.excludeCredentials = existing.map(r => ({ type: 'public-key', id: r.credential_id }));

        return res.json({ success: true, options });
      } catch (err) {
        console.error('[ANON_PASSKEY] add/begin error:', err);
        return res.json({ success: false, msg: err.message || 'Internal server error' }, 500);
      }
    });

    /**
     * POST /api/v2/anon/passkey/add/finish
     * Verify attestation and attach the new passkey to the current anonymous identity.
     */
    group.post(/\/passkey\/add\/finish$/, async (req, res) => {
      try {
        if (!getEnableAnonymousAccess()) {
          return res.json({ success: false, msg: 'Anonymous access is disabled' }, 403);
        }

        const userId = await getAnonSessionUserId(req);
        if (!userId) {
          return res.json({ success: false, msg: 'Not logged in as anonymous' }, 401);
        }
        if (!req.session.csrf_token || req.headers['x-csrf-token'] !== req.session.csrf_token) {
          return res.json({ success: false, msg: 'Invalid CSRF token' }, 403);
        }

        const body = req.post || req.body || {};
        const { challenge, clientDataJSON, attestationObject, credentialId, hw_fingerprint: rawHw } = body;
        const hwFingerprint = acceptHw(rawHw);
        if (!challenge || !clientDataJSON || !attestationObject || !credentialId) {
          return res.json({ success: false, msg: 'Missing required WebAuthn fields' }, 400);
        }

        let challengeMeta;
        try {
          challengeMeta = consumeChallenge(challenge);
        } catch (e) {
          return res.json({ success: false, msg: 'Challenge expired or invalid' }, 400);
        }
        if (challengeMeta.type !== 'anon-add' || challengeMeta.userId !== userId) {
          return res.json({ success: false, msg: 'Wrong challenge type' }, 400);
        }

        // Re-check here too: two add flows could have been started in parallel
        if (await countPasskeys(userId) >= MAX_ANON_PASSKEYS) {
          return res.json({ success: false, msg: `You can have at most ${MAX_ANON_PASSKEYS} passkeys.` }, 400);
        }

        let regResult;
        try {
          regResult = await verifyRegistration({ challenge, clientDataJSON, attestationObject, credentialId, rpId: getRpIdFromHost(req.headers.host) });
        } catch (e) {
          console.warn('[ANON_PASSKEY] Add verification failed:', e.message);
          return res.json({ success: false, msg: `Registration failed: ${e.message}` }, 400);
        }

        const taken = await db`SELECT user_id FROM passkey_credentials WHERE credential_id = ${credentialId} LIMIT 1`;
        if (taken.length > 0) {
          return res.json({ success: false, msg: 'This passkey is already registered.' }, 409);
        }

        const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(credentialId)).digest().toString('base64').replace(/=+$/, '');
        const auditIp = resolveAuditIP(req);

        await db`
          INSERT INTO passkey_credentials (user_id, credential_id, public_key_spki, sign_count, aaguid, name)
          VALUES (${userId}, ${credentialId}, ${regResult.spki}, ${regResult.signCount}, ${regResult.aaguid || null}, ${'Passkey'})
        `;
        await db`
          INSERT INTO anon_identities (user_id, credential_id, fingerprint, created_ip, last_ip, hw_fingerprint)
          VALUES (${userId}, ${credentialId}, ${fingerprint}, ${auditIp}, ${auditIp}, ${hwFingerprint || null})
          ON CONFLICT (credential_id) DO NOTHING
        `;

        const passkeyCount = await countPasskeys(userId);
        return res.json({ success: true, passkey_count: passkeyCount, passkey_max: MAX_ANON_PASSKEYS });
      } catch (err) {
        console.error('[ANON_PASSKEY] add/finish error:', err);
        return res.json({ success: false, msg: err.message || 'Internal server error' }, 500);
      }
    });

    // ─── Identity ─────────────────────────────────────────────────────────────

    /**
     * GET /api/v2/anon/passkeys
     * The current anonymous identity's passkeys (settings page). `primary` marks the one the
     * identity's fingerprint is derived from.
     */
    group.get(/\/passkeys$/, async (req, res) => {
      try {
        const userId = await getAnonSessionUserId(req);
        if (!userId) return res.json({ success: false, msg: 'Not logged in as anonymous' }, 401);
        const rows = await db`
          SELECT pc.id, pc.credential_id, pc.name, pc.aaguid, pc.created_at, pc.last_used,
                 (ai.credential_id IS NOT NULL) AS primary
          FROM passkey_credentials pc
          LEFT JOIN anon_identities ai ON ai.user_id = pc.user_id AND ai.credential_id = pc.credential_id
          WHERE pc.user_id = ${userId}
          ORDER BY pc.created_at ASC
        `;
        const [sess] = req.session.sess_id
          ? await db`SELECT passkey_credential_id FROM user_sessions WHERE id = ${+req.session.sess_id}`
          : [];
        const inUse = sess?.passkey_credential_id || null;
        return res.json({
          success: true,
          max: MAX_ANON_PASSKEYS,
          passkeys: rows.map(r => ({ ...r, provider: aaguidProvider(r.aaguid), current: !!inUse && r.credential_id === inUse }))
        });
      } catch (err) {
        console.error('[ANON_PASSKEY] list error:', err);
        return res.json({ success: false, msg: 'Failed to load passkeys' }, 500);
      }
    });

    /**
     * GET /api/v2/anon/identity
     * Get the current anonymous identity or registered user state.
     */
    group.get(/\/identity$/, async (req, res) => {
      try {
        if (!getEnableAnonymousAccess()) {
          return res.json({ logged_in: false, is_anon: false, disabled: true });
        }

        if (!req.session) {
          return res.json({ logged_in: false, is_anon: false });
        }

        const rows = await db`
          SELECT ai.credential_id, ai.fingerprint, ai.hw_fingerprint, ai.created_at, ai.last_seen,
                 pc.name AS passkey_name, pc.aaguid
          FROM anon_identities ai
          LEFT JOIN passkey_credentials pc ON pc.credential_id = ai.credential_id
          WHERE ai.user_id = ${req.session.id}
          ORDER BY ai.created_at ASC
          LIMIT 1
        `;

        if (rows.length > 0) {
          const fp = rows[0].fingerprint;
          return res.json({
            logged_in: true,
            is_anon: true,
            user_id: req.session.id,
            fingerprint: fp,
            short_fingerprint: fp ? fp.slice(7, 15) : null,
            hw_fingerprint: rows[0].hw_fingerprint,
            credential_id: rows[0].credential_id,
            passkey_name: rows[0].passkey_name,
            passkey_count: await countPasskeys(req.session.id),
            passkey_max: MAX_ANON_PASSKEYS,
            csrf_token: req.session.csrf_token
          });
        }

        return res.json({
          logged_in: true,
          is_anon: false,
          user: req.session.user,
          user_id: req.session.id,
          csrf_token: req.session.csrf_token
        });
      } catch (err) {
        console.error('[ANON_PASSKEY] Identity lookup error:', err);
        return res.json({ success: false, msg: err.message }, 500);
      }
    });

    // ─── Logout ───────────────────────────────────────────────────────────────

    /**
     * POST /api/v2/anon/logout
     * Clear anonymous session cookie and remove active session from database.
     */
    group.post(/\/logout$/, async (req, res) => {
      try {
        if (req.session && req.session.sess_id) {
          await db`
            DELETE FROM user_sessions
            WHERE id = ${+req.session.sess_id}
          `;
        }
        res.setHeader('Set-Cookie', `session=; ${lib.getCookieOptions('Thu, 01 Jan 1970 00:00:00 GMT')}`);
        return res.json({ success: true });
      } catch (err) {
        console.error('[ANON_PASSKEY] Logout error:', err);
        return res.json({ success: false, msg: err.message }, 500);
      }
    });

  });
};
