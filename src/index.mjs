import cfg from "./inc/config.mjs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import cuffeo from "cuffeo";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { getMotd, setMotd } from "./inc/motd.mjs";
import { getAboutText, setAboutText, getRulesText, setRulesText, getTermsText, setTermsText } from "./inc/page_texts.mjs";
import flummpress from "flummpress";
import { handleUpload } from "./upload_handler.mjs";
import { handleAvatarUpload, handleAvatarDelete } from "./avatar_handler.mjs";
import { handleBannerUpload, handleBannerDelete } from "./banner_handler.mjs";
import { handleBrandImageUpload, handleBrandImageDelete } from "./brand_image_handler.mjs";
import { handleRethumbUpload } from "./rethumb_handler.mjs";
import { handleMemeUpload, handleMemeEdit } from "./meme_upload_handler.mjs";
import { handleEmojiUpload, handleEmojiEdit } from "./emoji_upload_handler.mjs";
import { handleImportTelegramPack } from "./sticker_pack_handler.mjs";
import { handleHallImageUpload, handleHallImageDelete, handleHallDelete, handleHallUpdate, handleHallCreate } from "./hall_image_handler.mjs";
import { handleMetaExtract } from "./meta_extract_handler.mjs";
import { handleMetaStrip } from "./meta_strip_handler.mjs";
import { handleCommentUpload, handleCommentUploadCancel } from "./comment_upload_handler.mjs";
import { handleDmAttachmentUpload, handleDmAttachmentDownload, handleDmAttachmentDelete } from "./dm_attachment_handler.mjs";
import { handleChatUpload, handleChatUploadInfo, handleChatUploadDelete, handleChatUploadServe } from "./chat_upload_handler.mjs";
import { handleChatPreview, handleChatPreviewImage } from "./chat_preview_handler.mjs";
import { getManualApproval, setManualApproval, getMinTags, setMinTags, getRegistrationOpen, setRegistrationOpen, getTrustedUploads, setTrustedUploads, getBypassDuplicateCheck, setBypassDuplicateCheck, getProtectFiles, setProtectFiles, getPrivateMessages, setPrivateMessages, getDmAttachments, setDmAttachments, getDmUnencrypted, setDmUnencrypted, getDefaultLayout, setDefaultLayout, getEnablePdf, setEnablePdf, getEnableCleanup, setEnableCleanup, getCleanupStartDate, setCleanupStartDate, getCleanupEndDate, setCleanupEndDate, getCleanupIncludeEngaged, setCleanupIncludeEngaged, getLogUserIps, setLogUserIps, getHashUserIps, setHashUserIps, getShitpostMode, setShitpostMode, getAllowCommentDeletion, setAllowCommentDeletion, getNsfpIds, setNsfpIds, getEnableExpiringUploads, getEnableItemSlugs, getEnableAnonymousAccess, getAnonPermissions, getAnonAnonymize, isAnonymizeSession, ensureAllItemsHaveSlugs, ensureAllAlbumItemsHaveSlugs, isAnonSession, canAnonDo, canUseChan, isOnaraEnabledFor, getSessionOwnerName, getAnonAllowedModes, getAnonAllowedMimes, getBrandImageUrl, setBrandImageUrl, getHwFingerprintEnabled } from "./inc/settings.mjs";
import { updateHallsCache, getHalls } from "./inc/halls_cache.mjs";
import { createI18n } from "./inc/i18n.mjs";
import { safeDeleteMediaFile, purgeExpiredUploads } from "./inc/lib_delete.mjs";

import security, { getIpHashSource } from "./inc/security.mjs";
import { initPrivateItems, getPrivateItemFromPath, isPrivateItemPath, render502, render451 } from "./inc/private_items.mjs";
import { startRetention } from "./inc/retention.mjs";
import { isSquareClickerActive } from "./inc/square_clicker.mjs";

import { createRequire } from 'module';
const _require = createRequire(import.meta.url);

const addCookieHeader = (res, cookieStr) => {
  if (!res || !res.setHeader) return;
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookieStr]);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieStr]);
  } else {
    res.setHeader('Set-Cookie', [existing, cookieStr]);
  }
};

// ─── Private Society Gate ────────────────────────────────────────────────────
// Powered by the cloudflare-error-page package.
// Each request gets a fresh page with a unique Ray ID + current UTC timestamp.
//
// Customise the visible text and status icons here:
const gateOptions = {
  title:      'Bad Gateway',
  error_code: '502',
  what_happened: "There is an internal server error on Cloudflare&#39;s network.",
  // what_can_i_do is injected dynamically below (Sign in button)

  error_source: 'host',

  browser_status: {
    status:      'ok',
    location:    'You',
    name:        'Browser',
    status_text: 'Working',
  },
  cloudflare_status: {
    status:      'ok',
    location:    cfg.websrv.private_society_gate_location || 'Frankfurt',
    name:        'Cloudflare',
    status_text: 'Working',
  },
  host_status: {
    status:      'error',
    location:    cfg.main.url.domain,
    name:        'Host',
    status_text: 'Error',
  },

  more_information: {
    hidden: false,
    text:   'cloudflare.com',
    link:   '',
    for:    'more information',
  },
  perf_sec_by: { text: '', link: '' },
};

// Fallback when the package isn't installed
const nginx502Fallback = `<html>
<head><title>502 Bad Gateway</title></head>
<body bgcolor="white">
<center><h1>502 Bad Gateway</h1></center>
<hr><center>nginx</center>
</body>
</html>`;

// Login + Register modal injected before </body>
// Dynamic function so reCAPTCHA can be bypassed for .onion requests
const _rcEnabled = !!(cfg.recaptcha && cfg.recaptcha.enabled && cfg.recaptcha.site_key);
const _rcSiteKey = (cfg.recaptcha && cfg.recaptcha.site_key) || '';

function getGateLoginInjection(req) {
  const rcEnabled = _rcEnabled && !lib.isOnionRequest(req) && !lib.isLocalhostRequest(req);
  return `
<div id="hot-corner" style="position:fixed;bottom:0;left:0;width:20px;height:20px;z-index:9999;"></div>

<div id="gate-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10000;align-items:center;justify-content:center;">
  <div style="background:#f0f0f0;border:1px solid #999;color:#404040;border-radius:0;box-shadow:4px 4px 8px rgba(0,0,0,0.25);font-family:system-ui,-apple-system,sans-serif;padding:28px 32px;min-width:340px;max-width:94vw;width:360px;position:relative;">
    <button id="gate-modal-close" style="position:absolute;top:10px;right:14px;background:none;border:none;font-size:22px;color:#666;cursor:pointer;line-height:1;">&times;</button>

    <!-- Login View -->
    <div id="gate-login-view">
      <form id="gate-login-form" novalidate style="display:flex;flex-direction:column;gap:10px;">
        <h2 style="text-align:center;margin:0 0 14px;font-size:1.2em;font-weight:600;color:#222;">Sign in</h2>
        <div id="gate-login-error" style="display:none;background:#fde8e8;border:1px solid #e0a0a0;color:#bd2426;padding:7px 10px;font-size:13px;text-align:center;"></div>
        <input type="text" name="username" placeholder="Username or email" autocomplete="off" required
          style="background:white;color:black;border:1px solid #bbb;padding:7px 10px;width:100%;box-sizing:border-box;font-size:14px;font-family:inherit;" />
        <input type="password" name="password" placeholder="Password" autocomplete="off" required
          style="background:white;color:black;border:1px solid #bbb;padding:7px 10px;width:100%;box-sizing:border-box;font-size:14px;font-family:inherit;" />
        <label style="font-size:12px;color:#555;display:flex;align-items:center;gap:6px;"><input type="checkbox" name="kmsi" style="margin:0;"> Stay signed in</label>
        <button type="submit" id="gate-login-btn" style="background:#0051c3;color:white;border:none;padding:9px;font-weight:600;font-size:14px;cursor:pointer;font-family:inherit;"
          onmouseover="this.style.background='#003681'" onmouseout="if(!this.disabled)this.style.background='#0051c3'">Sign in</button>
        <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
          <hr style="flex:1;border:none;border-top:1px solid #ccc;">
          <span style="font-size:11px;color:#999;">or</span>
          <hr style="flex:1;border:none;border-top:1px solid #ccc;">
        </div>
        <button type="button" id="gate-passkey-btn" style="background:#f5f5f5;color:#333;border:1px solid #ccc;padding:9px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;"
          onmouseover="this.style.background='#eaeaea'" onmouseout="this.style.background='#f5f5f5'">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
          Sign in with Passkey
        </button>
        <p style="text-align:center;font-size:0.85em;margin:6px 0 0;color:#555;">
          No account? <a href="#" id="gate-to-register" style="color:#0051c3;text-decoration:underline;">Register</a>
        </p>
      </form>
    </div>

    <!-- Register View -->
    <div id="gate-register-view" style="display:none;">
      <form id="gate-register-form" novalidate style="display:flex;flex-direction:column;gap:10px;">
        <h2 style="text-align:center;margin:0 0 14px;font-size:1.2em;font-weight:600;color:#222;">Create account</h2>
        <div id="gate-register-error" style="display:none;background:#fde8e8;border:1px solid #e0a0a0;color:#bd2426;padding:7px 10px;font-size:13px;text-align:center;"></div>
        <div id="gate-register-ok" style="display:none;background:#e8fde8;border:1px solid #a0e0a0;color:#2a7a2a;padding:7px 10px;font-size:13px;text-align:center;"></div>
        <input type="text" name="username" placeholder="Username" autocomplete="off" required
          style="background:white;color:black;border:1px solid #bbb;padding:7px 10px;width:100%;box-sizing:border-box;font-size:14px;font-family:inherit;" />
        <input type="password" name="password" placeholder="Password (min. 20 characters)" autocomplete="off" required minlength="20"
          style="background:white;color:black;border:1px solid #bbb;padding:7px 10px;width:100%;box-sizing:border-box;font-size:14px;font-family:inherit;" />
        <input type="password" name="password_confirm" placeholder="Confirm password" autocomplete="off" required minlength="20"
          style="background:white;color:black;border:1px solid #bbb;padding:7px 10px;width:100%;box-sizing:border-box;font-size:14px;font-family:inherit;" />
        <input type="text" name="token" placeholder="Invite token" autocomplete="off"
          style="background:white;color:black;border:1px solid #bbb;padding:7px 10px;width:100%;box-sizing:border-box;font-size:14px;font-family:inherit;" />
        <input type="text" name="email_confirm_field" style="display:none !important;" tabindex="-1" autocomplete="off" />
        ${rcEnabled ? '<div id="gate-recaptcha" style="margin:4px 0;transform-origin:left top;"></div>' : ''}
        <button type="submit" id="gate-register-btn" style="background:#0051c3;color:white;border:none;padding:9px;font-weight:600;font-size:14px;cursor:pointer;font-family:inherit;"
          onmouseover="this.style.background='#003681'" onmouseout="if(!this.disabled)this.style.background='#0051c3'">Create account</button>
        <p style="text-align:center;font-size:0.85em;margin:6px 0 0;color:#555;">
          <a href="#" id="gate-to-login" style="color:#0051c3;text-decoration:underline;">Back to sign in</a>
        </p>
      </form>
    </div>
  </div>
</div>

<script>
  function openLoginGate(view) {
    var m = document.getElementById('gate-modal');
    if (!m) return;
    m.style.display = 'flex';
    gateShowView(view || 'login');
  }
  function gateShowView(view) {
    document.getElementById('gate-login-view').style.display    = view === 'login'    ? '' : 'none';
    document.getElementById('gate-register-view').style.display = view === 'register' ? '' : 'none';
    if (view === 'register') gateRenderRecaptcha();
  }
  function gateSetError(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
  }
  function gateSetBtn(id, loading) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = loading;
    btn.style.opacity = loading ? '0.65' : '1';
    btn.style.cursor = loading ? 'default' : 'pointer';
  }

  // reCAPTCHA
  var _gateRcWidgetId = null;
  var _gateRcLoaded   = false;
  function gateRenderRecaptcha() {
    var el = document.getElementById('gate-recaptcha');
    if (!el || !window.grecaptcha) return;
    if (_gateRcWidgetId !== null) {
      try { grecaptcha.reset(_gateRcWidgetId); } catch(e) {}
    } else {
      _gateRcWidgetId = grecaptcha.render(el, { sitekey: '${_rcSiteKey}', theme: 'light' });
    }
  }
  window.onRecaptchaGateReady = function() {
    _gateRcLoaded = true;
    var rv = document.getElementById('gate-register-view');
    if (rv && rv.style.display !== 'none') gateRenderRecaptcha();
  };

  document.addEventListener('DOMContentLoaded', function() {
    var modal = document.getElementById('gate-modal');
    var close = document.getElementById('gate-modal-close');
    if (close) close.onclick = function() { modal.style.display = 'none'; };
    if (modal) modal.addEventListener('click', function(e) { if (e.target === this) this.style.display = 'none'; });

    document.getElementById('gate-to-register').onclick = function(e) { e.preventDefault(); gateShowView('register'); };
    document.getElementById('gate-to-login').onclick    = function(e) { e.preventDefault(); gateShowView('login'); };

    var hc = document.getElementById('hot-corner');
    if (hc) hc.onclick = function() { openLoginGate('login'); };

    // Login form
    document.getElementById('gate-login-form').onsubmit = function(e) {
      e.preventDefault();
      gateSetError('gate-login-error', '');
      gateSetBtn('gate-login-btn', true);
      var fd = new FormData(this);
      var body = new URLSearchParams(fd).toString();
      fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: body
      })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success === false) {
          gateSetError('gate-login-error', d.msg || 'Login failed.');
          gateSetBtn('gate-login-btn', false);
        } else {
          window.location.reload();
        }
      })
      .catch(function() { window.location.reload(); });
    };

    // Register form
    document.getElementById('gate-register-form').onsubmit = function(e) {
      e.preventDefault();
      gateSetError('gate-register-error', '');
      gateSetError('gate-register-ok', '');
      gateSetBtn('gate-register-btn', true);
      var fd = new FormData(this);
      if (_gateRcWidgetId !== null && window.grecaptcha) {
        var token = grecaptcha.getResponse(_gateRcWidgetId);
        if (!token) {
          gateSetError('gate-register-error', 'Please complete the CAPTCHA.');
          gateSetBtn('gate-register-btn', false);
          return;
        }
        fd.append('g-recaptcha-response', token);
      }
      var body = new URLSearchParams(fd).toString();
      fetch('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: body
      })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        gateSetBtn('gate-register-btn', false);
        if (d.success === false) {
          gateSetError('gate-register-error', d.msg || 'Registration failed.');
          if (_gateRcWidgetId !== null && window.grecaptcha) { try { grecaptcha.reset(_gateRcWidgetId); } catch(e) {} }
        } else {
          document.getElementById('gate-register-ok').textContent = d.msg || 'Account created! You can now sign in.';
          document.getElementById('gate-register-ok').style.display = '';
          document.getElementById('gate-register-form').reset();
          setTimeout(function() { gateShowView('login'); }, 2000);
        }
      })
      .catch(function() {
        gateSetBtn('gate-register-btn', false);
        gateSetError('gate-register-error', 'An error occurred. Please try again.');
        if (_gateRcWidgetId !== null && window.grecaptcha) { try { grecaptcha.reset(_gateRcWidgetId); } catch(e) {} }
      });
    };
    // Passkey sign-in button (works for both registered users and anonymous passkey holders)
    var passkeyBtn = document.getElementById('gate-passkey-btn');
    if (passkeyBtn && window.PublicKeyCredential) {
      passkeyBtn.addEventListener('click', async function() {
        gateSetError('gate-login-error', '');
        passkeyBtn.disabled = true;
        passkeyBtn.style.opacity = '0.65';
        try {
          // 1. Get challenge from server
          var beginRes = await fetch('/api/v2/anon/passkey/auth/begin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          var beginData = await beginRes.json();
          if (!beginData.success) throw new Error(beginData.msg || 'Failed to begin passkey authentication');
          var rawChallenge = beginData.options.challenge; // save original base64url string for finish
          var opts = beginData.options;

          // 2. Decode base64url fields for WebAuthn API
          function b64urlToArr(b64) {
            var bin = atob(b64.replace(/-/g,'+').replace(/_/g,'/'));
            var arr = new Uint8Array(bin.length);
            for (var i=0; i<bin.length; i++) arr[i] = bin.charCodeAt(i);
            return arr;
          }
          function arrToB64url(arr) {
            var bin = '';
            new Uint8Array(arr).forEach(function(b) { bin += String.fromCharCode(b); });
            return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
          }

          var pkOpts = {
            challenge: b64urlToArr(rawChallenge),
            rpId: opts.rpId,
            userVerification: opts.userVerification || 'preferred',
            timeout: opts.timeout || 60000,
            allowCredentials: (opts.allowCredentials || []).map(function(c) {
              return { type: c.type, id: b64urlToArr(c.id) };
            })
          };

          // 3. Invoke browser passkey picker
          var assertion = await navigator.credentials.get({ publicKey: pkOpts });

          // 4. Send to server — use original base64url challenge string
          var finishRes = await fetch('/api/v2/anon/passkey/auth/finish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              challenge: rawChallenge,
              clientDataJSON: arrToB64url(assertion.response.clientDataJSON),
              authenticatorData: arrToB64url(assertion.response.authenticatorData),
              signature: arrToB64url(assertion.response.signature),
              credentialId: arrToB64url(assertion.rawId)
            })
          });
          var finishData = await finishRes.json();
          if (finishData.banned) {
            gateSetError('gate-login-error', 'You are banned: ' + (finishData.reason || ''));
            return;
          }
          if (!finishData.success) throw new Error(finishData.msg || 'Passkey authentication failed');

          window.location.reload();
        } catch(err) {
          if (err && err.name === 'NotAllowedError') {
            gateSetError('gate-login-error', 'Passkey prompt was cancelled.');
          } else {
            gateSetError('gate-login-error', err.message || 'Passkey sign-in failed.');
          }
        } finally {
          passkeyBtn.disabled = false;
          passkeyBtn.style.opacity = '1';
        }
      });
    } else if (passkeyBtn) {
      passkeyBtn.style.display = 'none'; // hide if no WebAuthn support
    }
  });

  var _sb = '';
  document.addEventListener('keydown', function(e) {
    _sb += e.key.toLowerCase();
    if (_sb.endsWith('foobarbaz')) { openLoginGate('login'); _sb = ''; }
    if (_sb.length > 12) _sb = _sb.slice(-12);
  });
</script>
${rcEnabled ? '<script src="https://www.google.com/recaptcha/api.js?onload=onRecaptchaGateReady&render=explicit" async defer><\/script>' : ''}
`;
}


// Text injected into the "What can I do?" section
const gateSignInButton = `You know what to do.`;



let _cfRender = null;
try {
  _cfRender = _require('cloudflare-error-page').render;
  console.log('[BOOT] cloudflare-error-page loaded — gate pages generated dynamically per request');
} catch (e) {
  console.warn('[BOOT] cloudflare-error-page not installed, falling back to plain nginx 502:', e.message);
}

// Called on every gated request — produces a fresh page with unique Ray ID + timestamp
// Accepts an optional request object to inject the visitor's real IP into the footer reveal and dynamic host into page text/title.
function buildGatePage(req) {
  if (!_cfRender) return nginx502Fallback;

  let reqHost = null;
  if (req && req.headers) {
    const rawHost = req.headers['x-forwarded-host'] || req.headers['host'];
    if (rawHost) {
      const firstHost = rawHost.split(',')[0].trim();
      let extracted = '';
      if (firstHost.startsWith('[')) {
        const closeBracket = firstHost.indexOf(']');
        extracted = closeBracket !== -1 ? firstHost.substring(1, closeBracket) : firstHost;
      } else {
        extracted = firstHost.split(':')[0].trim();
      }
      const isLocalHost = ['localhost', '127.0.0.1', '::1', 'f0ckm', '0.0.0.0', 'localhost.localdomain'].includes(extracted.toLowerCase());
      if (extracted && !isLocalHost) {
        reqHost = extracted;
      }
    }
  }
  if (!reqHost) reqHost = cfg.main.url.domain;

  const currentGateOptions = {
    ...gateOptions,
    host_status: {
      ...gateOptions.host_status,
      location: reqHost,
    },
    what_can_i_do: gateSignInButton,
  };

  let html = _cfRender(currentGateOptions);

  // Inject real visitor IP into the footer "Your IP: [Click to reveal]" span
  if (req) {
    const visitorIp = security.getRealIP(req);
    html = html.replace(
      '<span class="hidden" id="cf-footer-ip">1.1.1.1</span>',
      `<span class="hidden" id="cf-footer-ip">${visitorIp}</span>`
    );
  }

  // Make the second 'a' in "Bad Gateway" a secret click trigger
  html = html.replace(
    '<span class="inline-block">Bad Gateway</span>',
    '<span class="inline-block">Bad Gatew<span id="secret-letter" style="cursor:text;" onclick="openLoginGate(\'login\')">a</span>y</span>'
  );
  // Patch the <title> to include the domain — matches real Cloudflare behaviour
  html = html.replace(
    '<title>502: Bad Gateway</title>',
    `<title>${reqHost} | 502: Bad gateway</title>`
  );
  html = html.replace('</body>', getGateLoginInjection(req) + '\n</body>');
  return html;
}

// nginx502 === null signals "dynamic cloudflare mode" to the middleware below
const nginx502 = (cfg.websrv.private_society && cfg.websrv.private_society_gate === 'cloudflare')
  ? null
  : nginx502Fallback;

global._buildGatePage = (req) => (nginx502 ?? buildGatePage(req));
global._nginx502 = nginx502Fallback;

// Custom gate template — resolved once at boot from config
// Set private_society_gate: "custom" and private_society_gate_template: "your-template-name" (no .html)
const _customGateTemplate = (cfg.websrv.private_society && cfg.websrv.private_society_gate === 'custom' && cfg.websrv.private_society_gate_template)
  ? String(cfg.websrv.private_society_gate_template).replace(/\.html$/i, '')
  : null;

if (nginx502 === null) console.log('[BOOT] Private society gate: Cloudflare dynamic mode');
if (_customGateTemplate)  console.log(`[BOOT] Private society gate: Custom template → views/${_customGateTemplate}.html (flummpress resolves extension)`);
// ─────────────────────────────────────────────────────────────────────────────



const origLog = console.log;

console.log = function(...args) {
    if (process.env.NODE_ENV === 'production') {
        if (typeof args[0] === 'string' && args[0].includes('[BOOT]')) {
            origLog.apply(console, args);
        }
        return;
    }
    origLog.apply(console, args);
};

const logCrash = (type, err) => {
  const timestamp = new Date().toISOString();
  const errMsg = err instanceof Error ? `${err.stack || err.message}` : JSON.stringify(err);
  const logEntry = `[${timestamp}] ${type}: ${errMsg}\n\n`;

  console.error(`[CRASH] ${type}:`, err);

  try {
    if (!fs.existsSync(cfg.paths.logs)) {
      fs.mkdirSync(cfg.paths.logs, { recursive: true });
    }
    fs.appendFileSync(path.join(cfg.paths.logs, 'crash.log'), logEntry);
  } catch (e) {
    console.error('Failed to write to crash.log:', e);
  }
};

process.on('unhandledRejection', err => {
  if (err && err.code === 'ERR_HTTP_HEADERS_SENT') return;
  logCrash('Unhandled Rejection', err);
  if (process.env.NODE_ENV === 'production') {
    // In production, we might want to restart, but let's see if we can stay alive
    // throw err; 
  }
});

process.on('uncaughtException', err => {
  logCrash('Uncaught Exception', err);
  process.exit(1);
});

(async () => {
  const self = {
    _trigger: new Map(),
    trigger: function trigger(args) {
      this.call = args.call;
      this.help = args.help || false;
      this.level = args.level || 0;
      this.name = args.name;
      this.active = args.hasOwnProperty("active") ? args.active : true;
      this.clients = args.clients || ["irc", "tg", "slack", "matrix"];
      this.f = args.f;
    },
    bot: await new cuffeo(cfg.clients)
  };

  // Ensure storage directories exist
  const initDirs = [
    cfg.paths.a, cfg.paths.b, cfg.paths.c, cfg.paths.t, cfg.paths.ca, cfg.paths.emojis, cfg.paths.memes, cfg.paths.tmp, cfg.paths.logs,
    path.join(cfg.paths.pending, 'b'), path.join(cfg.paths.pending, 't'), path.join(cfg.paths.pending, 'ca'),
    path.join(cfg.paths.deleted, 'b'), path.join(cfg.paths.deleted, 't'), path.join(cfg.paths.deleted, 'ca')
  ];
  for (const dir of initDirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      if (e.code !== 'EEXIST') console.warn(`[BOOT] Could not create directory ${dir}: ${e.message}`);
    }
  }

  // Wait for database & schema initialization to complete (auto-bootstrap if tables are missing)
  let dbReady = false;
  let dbAttempts = 0;
  while (!dbReady && dbAttempts < 30) {
    try {
      dbAttempts++;
      const tableCheck = await db`SELECT 1 FROM information_schema.tables WHERE table_name = 'items' LIMIT 1`;
      if (tableCheck.length === 0) {
        console.log('[BOOT] Database tables missing! Initializing schema from migrations/f0ckm_schema.sql...');
        await db.file('./migrations/f0ckm_schema.sql');
        console.log('[BOOT] Database schema initialization complete!');
      }
      dbReady = true;
    } catch (e) {
      if (dbAttempts === 1) {
        console.log(`[BOOT] Waiting for database connection... (${e.message})`);
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  if (dbReady) {
    console.log(`[BOOT] Database schema ready (took ${dbAttempts} attempt(s))`);
  } else {
    console.error('[BOOT] Database schema check timed out after 30 attempts!');
  }
  const timeout = 10000; // 10s module load timeout

  // Ensure clients are resolved (Safe-guard for Docker/Node versions)
  if (self.bot.clients) {
    self.bot.clients = await Promise.all(self.bot.clients);
  }

  console.time("loading");
  const modules = {
    events: (await fs.promises.readdir("./src/inc/events")).filter(f => f.endsWith(".mjs")),
    trigger: (await fs.promises.readdir("./src/inc/trigger")).filter(f => f.endsWith(".mjs"))
  };

  console.timeLog("loading", "directories");
  const blah = (await Promise.all(Object.entries(modules).map(async ([dir, mods]) => ({
    [dir]: (await Promise.all(mods.map(async mod => {
      const res = await Promise.race([
        (await import(`./inc/${dir}/${mod}`)).default(self),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Module loading timed out: ${dir}/${mod}`)), timeout))
      ]);
      console.timeLog("loading", `${dir}/${mod}`);
      return res;
    }))).flat(2)
  })))).reduce((a, b) => ({ ...a, ...b }));

  blah.events.forEach(event => {
    console.timeLog("loading", `registering event > ${event.name}`);
    self.bot.on(event.listener, event.f);
  });

  blah.trigger.forEach(trigger => {
    console.timeLog("loading", `registering trigger > ${trigger.name}`);
    self._trigger.set(trigger.name, new self.trigger(trigger));
  });

  // Auto-migrate schema: ensure user_options & items columns exist
  const runMigration = async (query) => {
    try { await query; } catch (e) { /* ignore if table doesn't exist yet */ }
  };
  await runMigration(db`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS groups text[] DEFAULT '{}'`);
  await runMigration(db`ALTER TABLE user_options ADD COLUMN IF NOT EXISTS banner_file character varying(255) DEFAULT NULL`);
  await runMigration(db`ALTER TABLE user_options ADD COLUMN IF NOT EXISTS banner_position character varying(50) DEFAULT 'center'`);
  await runMigration(db`ALTER TABLE user_options ADD COLUMN IF NOT EXISTS banner_size character varying(50) DEFAULT 'cover'`);
  await runMigration(db`ALTER TABLE user_options ADD COLUMN IF NOT EXISTS banner_repeat character varying(50) DEFAULT 'repeat'`);
  await runMigration(db`ALTER TABLE items ADD COLUMN IF NOT EXISTS expires_at bigint DEFAULT NULL`);
  await runMigration(db`ALTER TABLE items ADD COLUMN IF NOT EXISTS width integer DEFAULT NULL`);
  await runMigration(db`ALTER TABLE items ADD COLUMN IF NOT EXISTS height integer DEFAULT NULL`);
  await runMigration(db`ALTER TABLE items ADD COLUMN IF NOT EXISTS original_filename text DEFAULT NULL`);
  await runMigration(db`ALTER TABLE items ADD COLUMN IF NOT EXISTS title text DEFAULT NULL`);
  await runMigration(db`ALTER TABLE items ADD COLUMN IF NOT EXISTS uploader_ip character varying(128) DEFAULT NULL`);
  // IPs are only stored when websrv.log_user_ips is on (security.storableIP), so activity rows may have none
  await runMigration(db`ALTER TABLE anon_activity_log ALTER COLUMN ip DROP NOT NULL`);
  await runMigration(db`ALTER TABLE items ADD COLUMN IF NOT EXISTS is_album boolean DEFAULT false`);
  await runMigration(db`ALTER TABLE items ADD COLUMN IF NOT EXISTS album_count integer DEFAULT 0`);
  await runMigration(db`
    CREATE TABLE IF NOT EXISTS album_items (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      dest CHARACTER VARYING(60) NOT NULL,
      mime CHARACTER VARYING(100) NOT NULL,
      size INTEGER NOT NULL,
      checksum CHARACTER VARYING(255) NOT NULL,
      phash TEXT,
      width INTEGER,
      height INTEGER,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  await runMigration(db`CREATE INDEX IF NOT EXISTS idx_album_items_item_id ON album_items(item_id, order_index ASC)`);
  await runMigration(db`ALTER TABLE album_items ADD COLUMN IF NOT EXISTS slug character varying(60) DEFAULT NULL`);
  await runMigration(db`CREATE INDEX IF NOT EXISTS idx_album_items_slug ON album_items(slug)`);
  await runMigration(db`
    CREATE TABLE IF NOT EXISTS album_items_tags_assign (
      album_item_id INTEGER NOT NULL REFERENCES album_items(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES "user"(id) ON DELETE SET DEFAULT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      PRIMARY KEY (album_item_id, tag_id)
    )
  `);
  await runMigration(db`CREATE INDEX IF NOT EXISTS idx_album_items_tags_assign_tag_id ON album_items_tags_assign(tag_id)`);
  await runMigration(db`CREATE INDEX IF NOT EXISTS idx_album_items_tags_assign_album_item_id ON album_items_tags_assign(album_item_id)`);
  // Square Clicker: user-made beatmaps for audio and video items and their scores
  await runMigration(db`
    CREATE TABLE IF NOT EXISTS sqc_maps (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT 'Untitled',
      notes JSONB NOT NULL DEFAULT '[]'::jsonb,
      note_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      plays INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  await runMigration(db`CREATE INDEX IF NOT EXISTS idx_sqc_maps_item ON sqc_maps(item_id, created_at DESC)`);
  // Maps of one album entry (each entry is its own track)
  await runMigration(db`ALTER TABLE sqc_maps ADD COLUMN IF NOT EXISTS album_item_id INTEGER REFERENCES album_items(id) ON DELETE CASCADE`);
  await runMigration(db`
    CREATE TABLE IF NOT EXISTS sqc_scores (
      id SERIAL PRIMARY KEY,
      map_id INTEGER NOT NULL REFERENCES sqc_maps(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES "user"(id) ON DELETE CASCADE,
      score INTEGER NOT NULL DEFAULT 0,
      accuracy REAL NOT NULL DEFAULT 0,
      max_combo INTEGER NOT NULL DEFAULT 0,
      hits JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  await runMigration(db`CREATE INDEX IF NOT EXISTS idx_sqc_scores_map ON sqc_scores(map_id, score DESC)`);
  // Chat uploads (temporary file hosting), see migrations/add_chat_uploads.sql
  await runMigration(db`
    CREATE TABLE IF NOT EXISTS upload_api_keys (
      id serial PRIMARY KEY,
      name text NOT NULL,
      key_hash text NOT NULL UNIQUE,
      max_bytes bigint DEFAULT NULL,
      revoked boolean DEFAULT false NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      last_used_at timestamp with time zone
    )
  `);
  await runMigration(db`
    CREATE TABLE IF NOT EXISTS chat_uploads (
      id bigserial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      key_id integer REFERENCES upload_api_keys(id) ON DELETE SET NULL,
      original_name text DEFAULT '' NOT NULL,
      mime text NOT NULL,
      mime_hint text DEFAULT '' NOT NULL,
      size_bytes bigint DEFAULT 0 NOT NULL,
      delete_token_hash text NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      expires_at timestamp with time zone NOT NULL
    )
  `);
  await runMigration(db`CREATE INDEX IF NOT EXISTS idx_chat_uploads_expires_at ON chat_uploads(expires_at)`);

  // Ensure the NSFL rating tag exists under cfg.nsfl_tag_id — rating changes and feed filters
  // all reference that id, and tags_assign has a FK on tags.id
  if (cfg.enable_nsfl) {
    const nsflId = parseInt(cfg.nsfl_tag_id, 10);
    if (nsflId > 0) {
      try {
        const [byId] = await db`SELECT id, normalized FROM tags WHERE id = ${nsflId} LIMIT 1`;
        const [byName] = await db`SELECT id FROM tags WHERE normalized = 'nsfl' LIMIT 1`;
        if (byId && byId.normalized !== 'nsfl') {
          console.warn(`[BOOT] nsfl_tag_id ${nsflId} points to tag "${byId.normalized}", not "nsfl" — check config`);
        } else if (!byId && byName) {
          console.warn(`[BOOT] NSFL tag exists as id ${byName.id} but nsfl_tag_id is ${nsflId} — set nsfl_tag_id: ${byName.id} in config`);
        } else if (!byId) {
          await db`INSERT INTO tags (id, tag) VALUES (${nsflId}, 'nsfl') ON CONFLICT DO NOTHING`;
          console.log(`[BOOT] Created missing NSFL rating tag (id ${nsflId})`);
        }
      } catch (e) {
        console.error('[BOOT] NSFL tag check failed:', e.message);
      }
    }
  }

  // Initial halls cache (only if halls are enabled)
  if (cfg.websrv.halls_enabled !== false) {
    try {
      await updateHallsCache();
    } catch (e) {
      // ignore during early init
    }
  }

  // Log feature flags
  console.log(`[BOOT] Halls: ${cfg.websrv.halls_enabled !== false ? 'ENABLED' : 'DISABLED'}`);
  console.log(`[BOOT] UserHalls: ${cfg.websrv.userhalls_enabled !== false ? 'ENABLED' : 'DISABLED'}`);
  console.log(`[BOOT] Abyss: ${cfg.websrv.abyss_enabled !== false ? 'ENABLED' : 'DISABLED'}`);

  //console.timeEnd("loading");


  // websrv
  const app = new flummpress();
  const router = app.router;
  const tpl = app.tpl;


  // Security headers — applied to every response before any route logic
  app.use(async (req, res) => {
    const isSecure = cfg.main.url?.full?.startsWith('https');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // Encourage connection reuse — helps external tools like ShareX avoid repeated TCP/TLS handshakes
    res.setHeader('Connection', 'keep-alive');

    // Block incoming requests to .onion if Tor Hidden Service is explicitly disabled in config
    if (cfg.websrv?.enable_tor_hs === false && lib.isOnionRequest(req)) {
      res.writeHead(503).end();
      req.url.pathname = '/tor_hs_disabled_bypass';
      return;
    }

    // Tor Onion-Location header: advertises .onion service counterpart to Tor Browser users when enabled
    if (cfg.websrv?.enable_tor_hs !== false && cfg.main?.onion && !lib.isOnionRequest(req)) {
      const p = req.url?.pathname || '/';
      const s = req.url?.search || '';
      const onionHost = cfg.main.onion.replace(/\/+$/, '');
      res.setHeader('Onion-Location', `${onionHost}${p}${s}`);
    }

    if (isSecure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  // Block all comment-related routes when enable_comments is disabled
  app.use(async (req, res) => {
    if (cfg.enable_comments !== false) return;
    const p = req.url?.pathname || '';
    const isCommentRoute =
      /^\/api\/comments/.test(p) ||
      /^\/api\/comment\//.test(p) ||
      /^\/api\/subscribe\//.test(p) ||
      /^\/api\/subscriptions/.test(p) ||
      /^\/subscriptions(\/|$)/.test(p) ||
      /^\/ajax\/subscriptions(\/|$)/.test(p) ||
      /^\/api\/polls\//.test(p) ||
      /^\/activity(\/|$)/.test(p) ||
      /^\/user\/[^/]+\/comments/.test(p) ||
      /^\/api\/v2\/comments/.test(p) ||
      /^\/api\/v2\/user\/subscribe-all-uploads/.test(p);
    if (isCommentRoute) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ success: false, message: "Comments are disabled" }));
      req.url.pathname = '/comments_disabled_bypass';
    }
  });

  // Global CORS & OPTIONS preflight handler for API routes (enables standalone config_editor.html)
  app.use(async (req, res) => {
    if (req.url?.pathname?.startsWith('/api/')) {
      const origin = req.headers?.origin || '*';
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, X-CSRF-Token, Authorization, X-API-Key, X-Filename, X-Upload-Expiry, X-Delete-Token');

      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        req.url.pathname = '/handled_options_bypass';
        return;
      }
    }
  });

  // Serve standalone config_editor.html statically
  app.use(async (req, res) => {
    if (req.method === 'GET' && (req.url?.pathname === '/config_editor.html' || req.url?.pathname === '/config.html')) {
      try {
        const filePath = path.resolve(process.cwd(), "config_editor.html");
        const content = await fs.promises.readFile(filePath, "utf-8");
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(content);
        req.url.pathname = '/handled_config_editor_bypass';
      } catch (err) {
        res.writeHead(404).end("config_editor.html not found");
      }
    }
  });

  // Cache-Control headers for static assets.
  // flummpress router.static() sends no caching headers, which forces Chrome to
  // re-fetch all thumbnails on every grid visit even when they haven't changed.
  // Guard: only set long-lived caching when protect_files is OFF so we never attach
  // immutable headers to a 401 response (which would be incorrectly cached by browsers).
  app.use(async (req, res) => {
    const p = req.url?.pathname;
    if (!p) return;
    if (p.startsWith('/t/') || p.startsWith('/ca/') || p.startsWith('/b/') || p.startsWith('/s/') || p.startsWith('/a/') || p.startsWith('/c/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    if (getProtectFiles() || isPrivateItemPath(p)) return; // Protect-files or private item — don't cache
    if (p.startsWith('/t/') || p.startsWith('/ca/') || p.startsWith('/b/')) {
      // Thumbnails, covers, and source blobs: 1-year cache.
      // These never change for a given ID (content-addressed by item ID).
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (p.startsWith('/s/') && !p.startsWith('/s/emojis/') && !p.startsWith('/s/koepfe/')) {
      // CSS/JS/images in /s/ are versioned by query param (?v=...) — safe to cache long-term.
      // Emojis and koepfe are excluded (user-uploadable, mutable).
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else if (p.startsWith('/a/')) {
      // Avatars can be re-uploaded — use short cache with revalidation.
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    } else if (p.startsWith('/memes/') || p.startsWith('/s/emojis/') || p.startsWith('/s/koepfe/')) {
      // Mutable user content: short cache.
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  });

  // Block source map requests early — flummpress crashes on unknown MIME types (e.g. .map)
  app.use(async (req, res) => {
    if (req.url?.pathname?.endsWith('.map')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
      req.url.pathname = '/handled_map_bypass';
    }
  });

  // Handle missing default avatar with a redirect to 404.gif
  app.use(async (req, res) => {
    if (req.url.pathname === '/a/default.png') {
      const defaultAvatar = path.join(cfg.paths.a, 'default.png');
      if (!fs.existsSync(defaultAvatar)) {
        res.writeHead(302, { 'Location': '/s/img/404.gif' }).end();
        req.url.pathname = '/default_avatar_redirect_bypass';
      }
    }
  });

  // ─── Session cache ────────────────────────────────────────────────────────
  // The session middleware runs in parallel with all other app.use() handlers
  // (flummpress uses Promise.all). With many concurrent requests each doing a
  // DB SELECT, the pool (max:50) drains and nginx sees 502s. Caching the
  // session row for 5s and the upload-count for 30s eliminates the hot path.
  const SESSION_CACHE_TTL    = 5_000;  // ms — short enough to pick up bans quickly
  const UPLOAD_COUNT_CACHE_TTL = 30_000; // ms — upload window is 12h, stale for 30s is fine
  const _sessionCache     = new Map(); // sha256(cookie) -> { data: row, exp: number }
  const _uploadCountCache = new Map(); // username -> { count: number, exp: number }

  const _scGet = (hash) => {
    const e = _sessionCache.get(hash);
    if (e && e.exp > Date.now()) return e.data;
    _sessionCache.delete(hash);
    return null;
  };
  const _scSet = (hash, data) => {
    _sessionCache.set(hash, { data, exp: Date.now() + SESSION_CACHE_TTL });
    if (_sessionCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of _sessionCache) if (v.exp <= now) _sessionCache.delete(k);
    }
  };
  // Exposed so logout/ban routes can force-evict immediately
  global._invalidateSessionCache = (hash) => _sessionCache.delete(hash);

  const _ucGet = (username) => {
    const e = _uploadCountCache.get(username);
    if (e && e.exp > Date.now()) return e.count;
    _uploadCountCache.delete(username);
    return null;
  };
  const _ucSet = (username, count) => {
    _uploadCountCache.set(username, { count, exp: Date.now() + UPLOAD_COUNT_CACHE_TTL });
  };
  // Own uploads awaiting approval (user menu badge), keyed like items.username; same TTL
  const _pendingCountCache = new Map(); // lower(owner) -> { count: number, exp: number }
  // Allow upload handler to bust the caches after a successful upload
  global._invalidateUploadCountCache = (username) => {
    _uploadCountCache.delete(username);
    if (username) _pendingCountCache.delete(String(username).toLowerCase());
  };
  // ──────────────────────────────────────────────────────────────────────────

  app.use(async (req, res) => {
    // This can be used to annoy people on discord sending links to your site lmao, shouldnt be used though since it sucks ass
//     if (cfg.main.development && req.method === 'POST') console.error(`[BOOT] [DEBUG_POST] ${req.method} ${req.url.pathname}`);
//     const ua = (req.headers['user-agent'] || '').toLowerCase();
//     if (ua.includes('discordbot')) {
//       const isOembed = req.url.pathname.endsWith('.json');
//       if (isOembed) {
//         res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
//           type: "link",
//           version: "1.0",
//           title: "STOP USING DISCORD",
//           provider_name: "STOP USING DISCORD",
//           provider_url: "https://example.com"
//         }));
//         req.url.pathname = '/discordbot';
//         return;
//       }

//       res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!DOCTYPE html>
// <html>
// <head>
//   <meta charset="utf-8" />
//   <meta name="theme-color" content="#FF0000" />
//   <meta property="og:site_name" content="STOP USING DISCORD" />
//   <meta property="og:title" content="STOP USING DISCORD" />
//   <meta property="og:description" content="DISCORD IS EVIL, DO YOURSELF A FAVOUR AND STOP USING IT! THERE ARE ALTERNATIVES OUT THERE THAT DO NOT FUCK YOU OVER!" />
//   <meta property="og:image" content="https://i.imgur.com/erSILuG.png" />
//   <meta property="og:type" content="article" />
//   <meta property="twitter:card" content="summary_large_image" />
//   <title>STOP USING DISCORD</title>
// </head>
// <body></body>
// </html>`);
//       req.url.pathname = '/discordbot';
//       return;
//     }

    // sessionhandler
    req.session = false;
    if (req.url.pathname.match(/^\/(s)\//) && !req.url.pathname.startsWith('/s/emojis/'))
      return;
    if (req.url.pathname === '/manifest.json' || req.url.pathname === '/sw.js')
      return;
    if (req.url.pathname.match(/^\/(b|c|t|ca|a|memes)\//) || req.url.pathname.startsWith('/s/emojis/')) {
      const privItem = getPrivateItemFromPath(req.url.pathname);
      if (privItem) {
        if (privItem.isUnavailable) {
          // Unavailable item (visibility === 3):
          // Direct URLs MUST serve 451 when requested by non-admins (or without a session)
          let isAdmin = false;
          if (req.cookies?.session) {
            const _sessionHash = lib.sha256(req.cookies.session);
            let user = _scGet(_sessionHash);
            if (!user) {
              const urows = await db`
                select "user".id, "user".user, "user".admin, "user".is_moderator, "user".banned, "user".ban_expires
                from "user_sessions"
                left join "user" on "user".id = "user_sessions".user_id
                where "user_sessions".session = ${_sessionHash}
                limit 1
              `;
              if (urows.length > 0) {
                user = urows[0];
                _scSet(_sessionHash, user);
              }
            }
            if (user && !user.banned && user.admin) {
              isAdmin = true;
            }
          }

          if (!isAdmin) {
            render451(req, res);
            req.url.pathname = '/unavailable_item_bypass';
            return;
          }

          res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
          return;
        }

        // Private item (visibility === 2):
        // Direct URLs MUST serve 502 when requested without a session (or by unauthorized users),
        // regardless of the protect_files setting.
        let isAuthorized = false;
        if (req.cookies?.session) {
          const _sessionHash = lib.sha256(req.cookies.session);
          let user = _scGet(_sessionHash);
          if (!user) {
            const urows = await db`
              select "user".id, "user".user, "user".admin, "user".is_moderator, "user".banned, "user".ban_expires
              from "user_sessions"
              left join "user" on "user".id = "user_sessions".user_id
              where "user_sessions".session = ${_sessionHash}
              limit 1
            `;
            if (urows.length > 0) {
              user = urows[0];
              _scSet(_sessionHash, user);
            }
          }
          if (user && !user.banned) {
            const isOwner = user.user && user.user.toLowerCase() === privItem.owner.toLowerCase();
            const isAdminOrMod = !!(user.admin || user.is_moderator);
            if (isOwner || isAdminOrMod) {
              isAuthorized = true;
            }
          }
        }

        if (!isAuthorized) {
          render502(req, res);
          req.url.pathname = '/private_item_bypass';
          return;
        }

        // Authorized: set private cache control so media is never cached publicly
        res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        return;
      }

      // protect_files gates raw file URLs behind a session (401 if not logged in).
      // private_society also gates file URLs — but only when protect_files is ALSO enabled.
      // If private_society is on but protect_files is off, direct file URLs are intentionally
      // left public so they can be shared without requiring a login.
      if (getProtectFiles() && !req.cookies?.session) {
        if (cfg.websrv.private_society) {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(nginx502 ?? buildGatePage(req));
          req.url.pathname = '/private_society_media_bypass';
        } else {
          res.writeHead(401).end('Unauthorized');
          req.url.pathname = '/protect_files_bypass';
        }
        return;
      }
      return;
    }
    const availableThemes = cfg.websrv.themes || ['amoled', 'atmos', 'f0ck', 'f0ck95d', 'iced', 'orange', 'p1nk', '4d'];
    const defaultTheme = cfg.websrv.theme || 'amoled';
    req.theme = (req.cookies?.theme && availableThemes.includes(req.cookies.theme)) ? req.cookies.theme : defaultTheme;
    req.fullscreen = req.cookies.fullscreen || 0;

    if (req.cookies.session) {
      const _sessionHash = lib.sha256(req.cookies.session);
      let _cachedRow = _scGet(_sessionHash);
      let user;
      if (_cachedRow) {
        user = [_cachedRow];
      } else {
        user = await db`
          select "user".id, "user".login, "user".user, "user".admin, "user".is_moderator, "user".groups, "user".banned, "user".ban_reason, "user".ban_expires, "user".force_password_change, "user_sessions".id as sess_id, "user_sessions".csrf_token, "user_options".mode, "user_options".theme, "user_options".fullscreen, "user_options".excluded_tags, "user_options".avatar, "user_options".avatar_file, "user_options".banner_file, "user_options".banner_position, "user_options".banner_size, "user_options".banner_repeat, "user_options".show_motd, "user_options".strict_mode, "user_options".show_background, "user_options".use_new_layout, "user_options".username_color, "user_options".font, "user_options".disable_autoplay, "user_options".disable_swiping, "user_options".favorites_private, "user_options".hide_fav_badge, "user_options".default_upload_visibility, "user_options".description, "user_options".display_name, COALESCE("user_options".min_xd_score, 0) as min_xd_score, "user_options".ruffle_volume, "user_options".ruffle_background, "user_options".quote_emojis, "user_options".embed_youtube_in_comments, "user_options".hide_koepfe, "user_options".language, "user_options".use_alternative_infobox, "user_options".use_alternative_steuerung, "user_options".receive_system_notifications, "user_options".receive_user_notifications, "user_options".do_not_disturb, "user_options".comment_display_mode, "user_options".force_comment_display_mode, "anon_identities".fingerprint as anon_fingerprint
          from "user_sessions"
          left join "user" on "user".id = "user_sessions".user_id
          left join "user_options" on "user_options".user_id = "user_sessions".user_id
          left join "anon_identities" on "anon_identities".user_id = "user_sessions".user_id
          where "user_sessions".session = ${_sessionHash}
          limit 1
        `;
        if (user.length > 0) _scSet(_sessionHash, user[0]);
      }

      if (user.length === 0) {
        res.writeHead(307, { // delete session
          "Cache-Control": "no-cache, public",
          "Set-Cookie": `session=; ${lib.getCookieOptions('Thu, 01 Jan 1970 00:00:00 GMT')}`,
          "Location": req.url.originalUrl || req.url.pathname + (req.url.search || "")
        }).end();
        req.url.pathname = '/session_invalid_bypass';
        return;
      }

      req.session = user[0];
      if (req.session.anon_fingerprint) {
        if (!getEnableAnonymousAccess()) {
          req.session = false;
          res.setHeader('Set-Cookie', `session=; ${lib.getCookieOptions('Thu, 01 Jan 1970 00:00:00 GMT')}`);
        } else {
          req.session.is_anon = true;
          req.session.fingerprint = req.session.anon_fingerprint;
          req.session.anon_login = user[0].login;
          req.session.user = 'anonymous';
          req.session.display_name = 'Anonymous';
        }
      }
      // csrf_token is loaded from user_sessions table via the session query above
      if (req.session) {
        req.session.can_chan = canUseChan(req.session);
      }

      // Ban check (Session)
      if (req.session && req.session.banned && !req.url.pathname.match(/^\/(banned|logout)(\/)?$/)) {
        const now = new Date();
        if (req.session.ban_expires && new Date(req.session.ban_expires) < now) {
          // Ban expired, lift it
          await db`update "user" set banned = false, ban_reason = null, ban_expires = null where id = ${+req.session.id}`;
          req.session.banned = false;
        } else {
          if (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.url.pathname.startsWith('/api/')) {
            res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({
              success: false,
              banned: true,
              msg: 'YOU ARE BANNED!',
              reason: req.session.ban_reason || 'Banned',
              expires: req.session.ban_expires ? new Date(req.session.ban_expires).toLocaleString() : 'Permanent',
              redirect: '/banned'
            }));
            req.url.pathname = '/ban_redirect_bypass';
            return;
          }
          res.writeHead(307, {
            "Location": "/banned"
          }).end();
          req.url.pathname = '/ban_redirect_bypass';
          return;
        }
      }

      // Ban check (IP and Fingerprint - applies to all requests, even without active session)
      if (!req.url.pathname.match(/^\/(banned|logout|s\/|a\/|t\/|b\/|c\/|favicon\.ico)(\/)?$/)) {
        const clientIp = security.getRealIP(req);
        const ipBan = await security.isIpBanned(clientIp);
        const fp = req.session?.fingerprint || req.session?.anon_fingerprint;
        const fpBan = fp ? await security.isFingerprintBanned(fp) : null;
        const banInfo = ipBan || fpBan;

        if (banInfo) {
          if (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.url.pathname.startsWith('/api/')) {
            res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({
              success: false,
              banned: true,
              msg: 'YOU ARE BANNED!',
              reason: banInfo.reason || 'Banned',
              expires: banInfo.expires ? new Date(banInfo.expires).toLocaleString() : 'Permanent',
              redirect: '/banned'
            }));
            req.url.pathname = '/ban_redirect_bypass';
            return;
          }
          res.writeHead(307, {
            "Location": "/banned"
          }).end();
          req.url.pathname = '/ban_redirect_bypass';
          return;
        }
      }

      // Password change check - Lockdown all other actions
      if (req.session.force_password_change && !req.url.pathname.match(/^\/(api\/v2\/settings\/password|logout)(\/)?$/)) {
        // If it's an API request or something other than a main page load, block it
        if (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.url.pathname.startsWith('/api/')) {
          res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: "Password change required", force_password_change: true }));
          req.url.pathname = '/force_password_change_bypass';
          return;
        }
        // For standard GET requests, we let it through so the header.html can render the modal,
        // but we'll use CSS to hide the content in header.html.
      }

      // ── Admin impersonation overlay ───────────────────────────────────────────
      // If the admin has an `impersonate` cookie set, overlay the target user's
      // session data. The admin's real session passes all security checks above,
      // then we swap req.session to look like the target user for the rest of the
      // request. The admin's identity is preserved in _impersonated_by.
      const _impersonateCookie = req.cookies?.impersonate;
      if (_impersonateCookie && req.session.admin &&
          !req.url.pathname.startsWith('/api/v2/admin/stop-impersonate') &&
          !req.url.pathname.startsWith('/api/v2/admin/impersonate')) {
        try {
          const [impPayload, impSig] = _impersonateCookie.split('.');
          if (impPayload && impSig) {
            const { createHmac, timingSafeEqual } = await import('crypto');
            const expectedSig = createHmac('sha256', lib.impersonationSecret()).update(impPayload).digest('hex');
            if (impSig.length === expectedSig.length && timingSafeEqual(Buffer.from(impSig), Buffer.from(expectedSig))) {
              const impData = JSON.parse(Buffer.from(impPayload, 'base64url').toString('utf8'));
              // Validate that the original session matches the current admin cookie
              if (impData.orig && impData.orig === lib.sha256(req.cookies.session)) {
                const targetRow = await db`
                  SELECT "user".id, "user".login, "user".user, "user".admin, "user".is_moderator, "user".groups, "user".banned, "user".ban_reason, "user".ban_expires, "user".force_password_change,
                    "user_options".mode, "user_options".theme, "user_options".fullscreen, "user_options".excluded_tags, "user_options".avatar, "user_options".avatar_file,
                    "user_options".show_motd, "user_options".strict_mode, "user_options".show_background, "user_options".use_new_layout, "user_options".username_color,
                    "user_options".font, "user_options".disable_autoplay, "user_options".disable_swiping, "user_options".favorites_private, "user_options".hide_fav_badge,
                    "user_options".default_upload_visibility, "user_options".description, "user_options".display_name, COALESCE("user_options".min_xd_score, 0) as min_xd_score,
                    "user_options".ruffle_volume, "user_options".ruffle_background, "user_options".quote_emojis, "user_options".embed_youtube_in_comments,
                    "user_options".hide_koepfe, "user_options".language, "user_options".use_alternative_infobox, "user_options".use_alternative_steuerung,
                    "user_options".receive_system_notifications, "user_options".receive_user_notifications, "user_options".do_not_disturb,
                    "user_options".comment_display_mode, "user_options".force_comment_display_mode
                  FROM "user"
                  LEFT JOIN "user_options" ON "user_options".user_id = "user".id
                  WHERE "user".id = ${+impData.uid}
                  LIMIT 1
                `;
                if (targetRow.length > 0) {
                  const adminUser = req.session.user;
                  const adminDisplayName = req.session.display_name || req.session.user;
                  req.session = {
                    ...targetRow[0],
                    // Preserve CSRF token from the real session for form submissions to still work
                    csrf_token: user[0].csrf_token,
                    sess_id: user[0].sess_id,
                    // Impersonation metadata — used in navbar template
                    _is_impersonating: true,
                    _impersonated_by: adminUser,
                    _impersonated_by_display: adminDisplayName,
                    // Suppress admin/mod powers in the impersonated view
                    admin: false,
                    is_moderator: false,
                  };
                  req._original_admin_session = user[0]; // stash for potential future use
                }
              }
            }
          }
        } catch (_impErr) {
          // Silently ignore malformed impersonate cookie
          console.error('[IMPERSONATE] Cookie parse error:', _impErr.message);
        }
      }

      // ── Admin role preview ("Preview: Mod / User" in the admin bar) ─────────────
      // `preview_role` cookie: a real admin sees and acts with the rights of that role (templates,
      // f0ckSession, admin/mod-guarded routes). It can only lower rights and is ignored for everyone
      // else. A copy is made so the cached session row keeps the real flags.
      const _previewRole = req.cookies?.preview_role;
      if ((_previewRole === 'mod' || _previewRole === 'user') && req.session.admin && !req.session._is_impersonating) {
        req.session = {
          ...req.session,
          admin: false,
          is_moderator: _previewRole === 'mod',
          _preview_role: _previewRole
        };
      }
      // ─────────────────────────────────────────────────────────────────────────

      // log last action (Fire-and-Forget)

      if (!req.url.pathname.startsWith('/api/notifications')) {
        const { getLogUserIps, getHashUserIps } = await import("./inc/settings.mjs");
        const currentIp = security.getRealIP(req);
        const finalIp = getHashUserIps() ? security.hashIP(currentIp) : currentIp;

        db`
        update "user_sessions" set ${db({
          last_used: ~~(Date.now() / 1e3),
          last_action: req.url.pathname,
          browser: req.headers['user-agent'],
          ...(getLogUserIps() ? { ip: finalIp } : {})
        }, 'last_used', 'last_action', 'browser', ...(getLogUserIps() ? ['ip'] : []))
          }
        where id = ${+user[0].sess_id}
        `.catch(e => console.error('[MIDDLEWARE] Session update failed:', e));

        // Update last_seen on user table (Fire-and-Forget) — feeds the 30-day orakel pool
        db`update "user" set last_seen = ${~~(Date.now() / 1e3)} where id = ${+user[0].id}`
          .catch(e => console.error('[MIDDLEWARE] last_seen update failed:', e));
          
        // Log IP for historical data
        security.logUserIP(user[0].id, currentIp);
      }

      if (req.session.admin) {
        const pending = await db`select count(*) as c from "items" where active = false and is_deleted = false`;
        req.session.pending_count = pending[0].c;
      }

      // Own pending uploads for the user menu badge, same rule as /pending (not live, not denied/purged)
      const _pendingOwner = getSessionOwnerName(req.session);
      if (_pendingOwner) {
        const key = _pendingOwner.toLowerCase();
        const hit = _pendingCountCache.get(key);
        if (hit && hit.exp > Date.now()) {
          req.session.own_pending_count = hit.count;
        } else {
          const [row] = await db`
            select count(*)::int as c from items
            where lower(username) = ${key} and active = false and is_deleted = false and is_purged = false
          `.catch(() => [{ c: 0 }]);
          req.session.own_pending_count = row?.c || 0;
          _pendingCountCache.set(key, { count: req.session.own_pending_count, exp: Date.now() + UPLOAD_COUNT_CACHE_TTL });
        }
      }

      // Calculate uploads remaining globally for the modal (cached 30s per user)
      if (!req.session.admin && !req.session.is_moderator) {
          let cachedUploadCount = _ucGet(req.session.user);
          if (cachedUploadCount === null) {
            const twelveHoursAgo = ~~(Date.now() / 1000) - (12 * 3600);
            const uploadCount = await db`
                SELECT count(*) as count
                FROM items
                WHERE username = ${req.session.user}
                AND stamp > ${twelveHoursAgo}
                AND is_deleted = false
            `;
            cachedUploadCount = parseInt(uploadCount[0].count);
            _ucSet(req.session.user, cachedUploadCount);
          }
          req.session.uploads_remaining = Math.max(0, cfg.main.upload_limit - cachedUploadCount);
      } else {
          req.session.uploads_remaining = undefined; // Unlimited for admins/mods
      }

      req.session.theme = req.theme;
      req.session.fullscreen = req.cookies.fullscreen;
      
      // Global upload settings for shared templates
      const { getMinTags } = await import("./inc/settings.mjs");
      req.session.min_tags = getMinTags();
      req.session.mimes_json = JSON.stringify(cfg.mimes);
      req.session.allowed_mimes = Object.keys(cfg.mimes).join(',');
      req.session.max_file_size = lib.formatSize(cfg.main.maxfilesize * (req.session.admin ? cfg.main.adminmultiplier : 1));
      req.session.max_file_size_bytes = Math.floor(cfg.main.maxfilesize * (req.session.admin ? cfg.main.adminmultiplier : 1));

      // update userprofile (Fire-and-Forget)
      // NOTE: mode is included in the INSERT for first-time row creation (NOT NULL col),
      // but intentionally excluded from ON CONFLICT DO UPDATE — mode is only updated
      // by the explicit /mode/:n route to prevent cross-device race conditions.
      db`
        insert into "user_options" ${db({
        user_id: +user[0].id,
        mode: user[0].mode ?? 0,
        theme: req.theme,
        fullscreen: req.session.fullscreen || 0,
        excluded_tags: req.session.excluded_tags || [],
        font: req.session.font || null,
        disable_autoplay: req.session.disable_autoplay ?? (cfg.websrv.enable_autoplay === false),
        disable_swiping: req.session.disable_swiping ?? (cfg.websrv.enable_swiping === false),
        show_background: req.session.show_background ?? (cfg.websrv.background !== false),
        ruffle_volume: user[0].ruffle_volume ?? null,
        ruffle_background: user[0].ruffle_background ?? true,
        quote_emojis: user[0].quote_emojis ?? true,
        embed_youtube_in_comments: user[0].embed_youtube_in_comments ?? (cfg.websrv.embed_youtube_in_comments !== false),
        hide_koepfe: user[0].hide_koepfe ?? false,
        language: (user[0].language && user[0].language.trim()) ? user[0].language.trim() : null,
        use_alternative_infobox: user[0].use_alternative_infobox ?? (cfg.websrv.user_alternative_infobox !== false),
        use_alternative_steuerung: user[0].use_alternative_steuerung ?? (cfg.websrv.user_alternative_steuerung !== false),
        comment_display_mode: user[0].comment_display_mode ?? (cfg.websrv.default_comment_display_mode || 0),
        force_comment_display_mode: user[0].force_comment_display_mode ?? 0
      }, 'user_id', 'mode', 'theme', 'fullscreen', 'excluded_tags', 'font', 'disable_autoplay', 'disable_swiping', 'show_background', 'ruffle_volume', 'ruffle_background', 'quote_emojis', 'embed_youtube_in_comments', 'hide_koepfe', 'language', 'use_alternative_infobox', 'use_alternative_steuerung', 'comment_display_mode', 'force_comment_display_mode')
        }
        on conflict ("user_id") do update set
        theme = excluded.theme,
          fullscreen = excluded.fullscreen,
          excluded_tags = excluded.excluded_tags,
          font = excluded.font,
          disable_autoplay = excluded.disable_autoplay,
          disable_swiping = excluded.disable_swiping,
          show_background = excluded.show_background,
          ruffle_volume = excluded.ruffle_volume,
          ruffle_background = excluded.ruffle_background,
          quote_emojis = excluded.quote_emojis,
          embed_youtube_in_comments = excluded.embed_youtube_in_comments,
          hide_koepfe = excluded.hide_koepfe,
          language = excluded.language,
          use_alternative_infobox = excluded.use_alternative_infobox,
          use_alternative_steuerung = excluded.use_alternative_steuerung,
          comment_display_mode = excluded.comment_display_mode,
          force_comment_display_mode = excluded.force_comment_display_mode,
          user_id = excluded.user_id
      `.catch(e => console.error('[MIDDLEWARE] Options sync failed:', e));
    }

    const queryMode = req.url.qs?.mode !== undefined ? +req.url.qs.mode : undefined;
    req.mode = queryMode !== undefined ? queryMode : (req.session ? +(req.session.mode ?? 0) : +(req.cookies?.mode ?? 0));

    const isGuest = !req.session || !req.session.user;

    if (isGuest) {
      req.mode = 0;

      // Ensure guests have mode=0 cookie
      if (req.cookies?.mode !== '0') {
        req.cookies = req.cookies || {};
        req.cookies.mode = '0';
        addCookieHeader(res, `mode=0; ${lib.getCookieOptions(31536000, false)}`);
      }

      // Ensure guests have ratings=sfw cookie
      if (req.cookies?.ratings !== 'sfw') {
        req.cookies = req.cookies || {};
        req.cookies.ratings = 'sfw';
        addCookieHeader(res, `ratings=sfw; ${lib.getCookieOptions(31536000, false)}`);
      }

      // Reconcile MIME cookie for guests
      const allowedMimes = cfg.anonymous_permissions?.allowed_mimes || ['image', 'video', 'audio'];
      if (req.cookies?.mime) {
        const rawMimes = decodeURIComponent(req.cookies.mime).split(',').filter(m => ['video', 'audio', 'image', 'flash', 'pdf'].includes(m));
        const validMimes = rawMimes.filter(m => allowedMimes.includes(m));
        if (validMimes.length !== rawMimes.length) {
          if (validMimes.length > 0) {
            req.cookies.mime = validMimes.join(',');
            addCookieHeader(res, `mime=${req.cookies.mime}; ${lib.getCookieOptions(31536000, false)}`);
          } else {
            delete req.cookies.mime;
            addCookieHeader(res, `mime=; ${lib.getCookieOptions(0, false)}`);
          }
        }
      }
    } else if (isAnonSession(req.session)) {
      const canFilter = canAnonDo('filter');
      const allowedModes = getAnonAllowedModes();
      const allowedMimes = getAnonAllowedMimes();
      const modeNames = ['sfw', 'nsfw', 'untagged', 'all', 'nsfl'];

      // Validate & reconcile req.mode
      const curModeName = modeNames[req.mode] || 'sfw';
      if (!canFilter || !allowedModes.includes(curModeName)) {
        const fallbackName = allowedModes.find(m => modeNames.includes(m)) || 'sfw';
        const fallbackIdx = modeNames.indexOf(fallbackName);
        req.mode = fallbackIdx >= 0 ? fallbackIdx : 0;
      }

      // If client sent a mode cookie that doesn't match the validated req.mode, auto-update it
      if (req.cookies?.mode !== undefined && +req.cookies.mode !== req.mode) {
        req.cookies.mode = String(req.mode);
        addCookieHeader(res, `mode=${req.mode}; ${lib.getCookieOptions(31536000, false)}`);
      }

      // Validate & reconcile ratings cookie
      if (req.cookies?.ratings) {
        const rawRatings = decodeURIComponent(req.cookies.ratings).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r));
        let validRatings = canFilter ? rawRatings.filter(r => allowedModes.includes(r)) : [];
        if (validRatings.length !== rawRatings.length) {
          if (validRatings.length === 0) {
            if (allowedModes.length === 1 && !allowedModes.includes('all')) {
              validRatings = [allowedModes[0]];
            }
          }
          if (validRatings.length > 0) {
            req.cookies.ratings = validRatings.join('|');
            addCookieHeader(res, `ratings=${req.cookies.ratings}; ${lib.getCookieOptions(31536000, false)}`);
          } else {
            delete req.cookies.ratings;
            addCookieHeader(res, `ratings=; ${lib.getCookieOptions(0, false)}`);
          }
        }
      }

      // Validate & reconcile mime cookie
      if (req.cookies?.mime) {
        const rawMimes = decodeURIComponent(req.cookies.mime).split(',').filter(m => ['video', 'audio', 'image', 'flash', 'pdf'].includes(m));
        const isSingleMime = allowedMimes.length === 1;
        if (isSingleMime) {
          const singleMime = allowedMimes[0];
          if (req.cookies.mime !== singleMime) {
            req.cookies.mime = singleMime;
            addCookieHeader(res, `mime=${singleMime}; ${lib.getCookieOptions(31536000, false)}`);
          }
        } else if (!canFilter) {
          delete req.cookies.mime;
          addCookieHeader(res, `mime=; ${lib.getCookieOptions(0, false)}`);
        } else {
          const validMimes = rawMimes.filter(m => allowedMimes.includes(m));
          if (validMimes.length !== rawMimes.length) {
            if (validMimes.length > 0) {
              req.cookies.mime = validMimes.join(',');
              addCookieHeader(res, `mime=${req.cookies.mime}; ${lib.getCookieOptions(31536000, false)}`);
            } else {
              delete req.cookies.mime;
              addCookieHeader(res, `mime=; ${lib.getCookieOptions(0, false)}`);
            }
          }
        }
      }
    }

    // Private Society gate — require login for all content when enabled
    if (cfg.websrv.private_society && !req.session) {
      const publicPaths = /^\/(s|login|logout|register|activate|forgot-password|reset-password|banned|api\/v2\/auth|api\/v2\/upload|api\/chat\/upload|api\/chat\/preview|cu|manifest\.json|sw\.js|robots\.txt|favicon\.(ico|png|gif)|s\/img\/duck-icon-(192|512)\.png)(\/.*)?$/;
      if (!publicPaths.test(req.url.pathname)) {
        // For AJAX requests, return 502 so it looks like the backend is down
        if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
          res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: 'Bad Gateway' }));
          req.url.pathname = '/private_society_bypass';
          return;
        }
        // For page requests, serve the gate for all paths (custom template or fallback)
        if (_customGateTemplate) {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(tpl.render(_customGateTemplate, {}, req));
        } else if (req.url.pathname !== '/') {
          // Non-home paths: always show the static/cloudflare gate
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(nginx502 ?? buildGatePage(req));
        } else if (nginx502 === null) {
          // Homepage in cloudflare dynamic mode: serve the CF gate directly
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(buildGatePage(req));
        } else {
          // Homepage in plain nginx mode: fall through to index.html template
          return;
        }
        req.url.pathname = '/private_society_bypass';
        return;
      }
    }
  });

  // Intercept app.readBody to allow memoized reading of request body.
  // flummpress runs app.use() in parallel via Promise.all before routing/body-reading,
  // so validateCsrf needs to be able to read req.post without breaking subsequent router handler body parsing.
  const _originalReadBody = app.readBody.bind(app);
  app.readBody = async (req) => {
    if (req.post !== undefined) return req.post;
    return await _originalReadBody(req);
  };

  // CSRF validation helper — used by route handlers and global middleware
  const validateCsrf = async (req, res) => {
    if (req.session && req.session.csrf_token) {
      let token = req.headers['x-csrf-token'] || req.body?.csrf_token || req.post?.csrf_token || req.url.qs?.csrf_token;
      
      // If header/query token is missing and body is not parsed yet on a non-GET method, parse it now
      if (!token && req.post === undefined && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        try {
          req.post = await app.readBody(req);
          token = req.post?.csrf_token;
        } catch (e) {}
      }

      if (!token || token !== req.session.csrf_token) {
        console.error(`[CSRF] Blocked ${req.method} ${req.url.pathname} for user ${req.session.user}. Reason: ${!token ? 'Missing token' : 'Token mismatch'}`);
        res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: 'Invalid CSRF token' }));
        req.url.pathname = '/csrf_blocked_bypass';
        return false;
      }
    }
    return true;
  };

  // CSRF Validation Middleware — only works for routes that go through the router (not bypass handlers)
  // because the session middleware will have completed by the time router callbacks execute.
  app.use(async (req, res) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (['/login', '/register', '/api/v2/anon/session', '/api/v2/anon/logout', '/api/v2/anon/passkey/register/begin', '/api/v2/anon/passkey/register/finish', '/api/v2/anon/passkey/auth/begin', '/api/v2/anon/passkey/auth/finish', '/api/v2/settings/passkeys/register/begin', '/api/v2/settings/passkeys/register/finish', '/api/v2/settings/passkeys/delete', '/api/v2/settings/passkeys/login/begin', '/api/v2/settings/passkeys/login/finish', '/api/v2/upload', '/api/v2/settings/uploadAvatar', '/api/v2/settings/uploadBanner', '/api/v2/admin/memes', '/api/v2/admin/emojis', '/api/v2/meta/extract-file', '/api/v2/meta/strip-gps', '/api/v2/scroller/external/rehost-meta', '/api/v2/comments/upload', '/api/v2/admin/sticker-packs/import', '/admin/brand_image/upload', '/admin/brand_image/delete'].includes(req.url.pathname)) return;
    // Chat uploads authenticate with an upload API key, not a session
    if (req.url.pathname.match(/^\/api\/chat\/upload(\/|$)/)) return;
    // DM attachment upload validates CSRF internally
    if (req.url.pathname.match(/^\/api\/dm\/attachment\/upload\//)) return;
    // Hall manager routes are handled by bypass middleware with their own session auth
    if (cfg.websrv.halls_enabled !== false && req.url.pathname.match(/^\/api\/v2\/admin\/halls(\/|$)/)) return;
    // User hall image upload is handled by bypass middleware below
    if (cfg.websrv.userhalls_enabled !== false && cfg.websrv.enable_userhall_image_upload !== false && req.url.pathname.match(/^\/api\/v2\/me\/halls\/[^/]+\/image$/)) return;
    if (!(await validateCsrf(req, res))) return;
  });

  // Bypass middleware for direct upload handling
  // CSRF is validated inside handleUpload after its own session lookup
  app.use(async (req, res) => {
    if (req.method === 'POST' && req.url.pathname === '/api/v2/upload') {
      await handleUpload(req, res, self);
      req.url.pathname = '/handled_upload_bypass';
    }
  });

  // Bypass middleware for video/image metadata extraction and GPS stripping
  app.use(async (req, res) => {
    if (req.method === 'POST' && req.url.pathname === '/api/v2/meta/extract-file') {
      await handleMetaExtract(req, res);
      req.url.pathname = '/handled_meta_extract_bypass';
    }
    if (req.method === 'POST' && req.url.pathname === '/api/v2/meta/strip-gps') {
      await handleMetaStrip(req, res);
      req.url.pathname = '/handled_meta_strip_bypass';
    }
  });

  // Bypass middleware for avatar upload (needs raw body before router consumes it)
  // CSRF is validated inside handleAvatarUpload/handleAvatarDelete after their own session lookups
  app.use(async (req, res) => {
    if (req.url.pathname === '/api/v2/settings/uploadAvatar') {
      if (req.method === 'POST') {
        await handleAvatarUpload(req, res);
        req.url.pathname = '/handled_avatar_upload_bypass';
      } else if (req.method === 'DELETE') {
        await handleAvatarDelete(req, res);
        req.url.pathname = '/handled_avatar_delete_bypass';
      }
    }
  });

  // Bypass middleware for brand image upload/delete (multipart — needs raw body before router)
  // CSRF is validated inside handleBrandImageUpload/handleBrandImageDelete after their own session lookups
  app.use(async (req, res) => {
    if (req.method === 'POST' && req.url.pathname === '/admin/brand_image/upload') {
      await handleBrandImageUpload(req, res);
      req.url.pathname = '/handled_brand_image_upload_bypass';
    } else if (req.method === 'POST' && req.url.pathname === '/admin/brand_image/delete') {
      await handleBrandImageDelete(req, res);
      req.url.pathname = '/handled_brand_image_delete_bypass';
    }
  });

  // Bypass middleware for banner upload (needs raw body before router consumes it)
  // CSRF is validated inside handleBannerUpload/handleBannerDelete after their own session lookups
  app.use(async (req, res) => {
    if (req.url.pathname === '/api/v2/settings/uploadBanner') {
      if (cfg.websrv.user_banner_enabled === false) {
        return res.reply({ success: false, msg: 'Banner feature is currently disabled' }, 403);
      }
      if (req.method === 'POST') {
        await handleBannerUpload(req, res);
        req.url.pathname = '/handled_banner_upload_bypass';
      } else if (req.method === 'DELETE') {
        await handleBannerDelete(req, res);
        req.url.pathname = '/handled_banner_delete_bypass';
      }
    }
  });

  // Bypass middleware for custom thumbnail uploads
  app.use(async (req, res) => {
    const thumbMatch = req.url.pathname.match(/^\/api\/v2\/items\/([^/]+)\/thumbnail$/);
    if (req.method === 'POST' && thumbMatch) {
        await handleRethumbUpload(req, res, thumbMatch[1]);
        req.url.pathname = '/handled_rethumb_upload_bypass';
    }
  });

  // Bypass middleware for meme template uploads
  app.use(async (req, res) => {
    if (req.method === 'POST' && req.url.pathname === '/api/v2/admin/memes') {
      await handleMemeUpload(req, res);
      req.url.pathname = '/handled_meme_upload_bypass';
    }
  });

  // Bypass middleware for meme template edits
  app.use(async (req, res) => {
    const editMatch = req.url.pathname.match(/^\/api\/v2\/admin\/memes\/(\d+)\/edit$/);
    if (req.method === 'POST' && editMatch) {
      req.params = { id: editMatch[1] };
      await handleMemeEdit(req, res);
      req.url.pathname = '/handled_meme_edit_bypass';
    }
  });

  // Bypass middleware for emoji uploads
  app.use(async (req, res) => {
    if (req.method === 'POST' && req.url.pathname === '/api/v2/admin/emojis') {
      await handleEmojiUpload(req, res);
      req.url.pathname = '/handled_emoji_upload_bypass';
    }
  });

  // Bypass middleware for emoji edits
  app.use(async (req, res) => {
    const editMatch = req.url.pathname.match(/^\/api\/v2\/admin\/emojis\/(\d+)\/edit$/);
    if (req.method === 'POST' && editMatch) {
      req.params = { id: editMatch[1] };
      await handleEmojiEdit(req, res);
      req.url.pathname = '/handled_emoji_edit_bypass';
    }
  });

  // Bypass middleware for Telegram sticker pack import
  app.use(async (req, res) => {
    if (req.method === 'POST' && req.url.pathname === '/api/v2/admin/sticker-packs/import') {
      await handleImportTelegramPack(req, res);
      req.url.pathname = '/handled_sticker_pack_import_bypass';
    }
  });

  // Bypass middleware for koepfe uploads
  app.use(async (req, res) => {
    if (req.method === 'POST' && req.url.pathname === '/api/v2/admin/koepfe/upload') {
      const { handleKoepfeUpload } = await import('./koepfe_handler.mjs');
      await handleKoepfeUpload(req, res);
      req.url.pathname = '/handled_koepfe_upload_bypass';
    }
  });

  // Bypass middleware for hall image uploads (multipart — needs raw body)
  app.use(async (req, res) => {
    if (cfg.websrv.halls_enabled === false) return;
    const hallImgMatch = req.url.pathname.match(/^\/api\/v2\/admin\/halls\/([^/]+)\/image$/);
    if (hallImgMatch) {
      console.error('[BOOT] [HALL BYPASS] Image path hit:', req.method, req.url.pathname, 'cookies:', JSON.stringify(Object.keys(req.cookies || {})));
      req.params = req.params || {};
      req.params.slug = decodeURIComponent(hallImgMatch[1]);
      if (req.method === 'POST') {
        await handleHallImageUpload(req, res);
        req.url.pathname = '/handled_hall_img_bypass';
      } else if (req.method === 'DELETE') {
        await handleHallImageDelete(req, res);
        req.url.pathname = '/handled_hall_img_bypass';
      }
    }
    // POST /api/v2/admin/halls (no slug) — create new hall
    if (req.method === 'POST' && req.url.pathname === '/api/v2/admin/halls') {
      await handleHallCreate(req, res);
      req.url.pathname = '/handled_hall_bypass';
    }
    const hallDeleteMatch = req.url.pathname.match(/^\/api\/v2\/admin\/halls\/([^/]+)$/);
    if (hallDeleteMatch && (req.method === 'DELETE' || req.method === 'PATCH')) {
      console.error('[BOOT] [HALL BYPASS] CRUD path hit:', req.method, req.url.pathname);
      req.params = req.params || {};
      req.params.slug = decodeURIComponent(hallDeleteMatch[1]);
      if (req.method === 'DELETE') {
        await handleHallDelete(req, res);
      } else {
        await handleHallUpdate(req, res);
      }
      req.url.pathname = '/handled_hall_bypass';
    }
  });

  // Bypass middleware for user hall image uploads (multipart — raw body needed)
  app.use(async (req, res) => {
    if (cfg.websrv.userhalls_enabled === false || cfg.websrv.enable_userhall_image_upload === false) return;
    const userHallImgMatch = req.url.pathname.match(/^\/api\/v2\/me\/halls\/([^/]+)\/image$/);
    if (userHallImgMatch && req.method === 'POST') {
      console.error('[BOOT] [USER_HALL BYPASS] Image upload:', req.url.pathname);
      const { handleUserHallImageUpload } = await import('./user_hall_image_handler.mjs');
      await handleUserHallImageUpload(req, res, decodeURIComponent(userHallImgMatch[1]));
      req.url.pathname = '/handled_user_hall_img_bypass';
    }
  });

  // Bypass middleware for comment file uploads (multipart — needs raw body)
  app.use(async (req, res) => {
    if (req.method === 'POST' && req.url.pathname === '/api/v2/comments/upload') {
      await handleCommentUpload(req, res);
      req.url.pathname = '/handled_comment_upload_bypass';
    }
    // DELETE /api/v2/comments/upload/:id — user cancels a staged attachment
    const cancelMatch = req.url.pathname.match(/^\/api\/v2\/comments\/upload\/(\d+)$/);
    if (req.method === 'DELETE' && cancelMatch) {
      await handleCommentUploadCancel(req, res, cancelMatch[1]);
      req.url.pathname = '/handled_comment_upload_cancel_bypass';
    }
  });

  // Bypass middleware for DM encrypted attachment upload/download/delete
  app.use(async (req, res) => {
    const uploadMatch   = req.url.pathname.match(/^\/api\/dm\/attachment\/upload\/(\d+)$/);
    const downloadMatch = req.url.pathname.match(/^\/api\/dm\/attachment\/(\d+)$/);
    if (req.method === 'POST' && uploadMatch) {
      await handleDmAttachmentUpload(req, res, uploadMatch[1]);
      req.url.pathname = '/handled_dm_attachment_upload_bypass';
    } else if (req.method === 'GET' && downloadMatch) {
      await handleDmAttachmentDownload(req, res, downloadMatch[1]);
      req.url.pathname = '/handled_dm_attachment_download_bypass';
    } else if (req.method === 'DELETE' && downloadMatch) {
      await handleDmAttachmentDelete(req, res, downloadMatch[1]);
      req.url.pathname = '/handled_dm_attachment_delete_bypass';
    }
  });

  // Bypass middleware for chat uploads: raw-body upload, delete, public download
  app.use(async (req, res) => {
    const p = req.url.pathname;
    const deleteMatch = p.match(/^\/api\/chat\/upload\/([A-Za-z0-9_-]{12})$/);
    const serveMatch  = p.match(/^\/cu\/([A-Za-z0-9_-]{12})(?:\/[^/]*)?$/);
    if (req.method === 'POST' && p === '/api/chat/upload') {
      await handleChatUpload(req, res);
      req.url.pathname = '/handled_chat_upload_bypass';
    } else if (req.method === 'GET' && p === '/api/chat/preview') {
      await handleChatPreview(req, res);
      req.url.pathname = '/handled_chat_preview_bypass';
    } else if (req.method === 'GET' && p === '/api/chat/preview/image') {
      await handleChatPreviewImage(req, res);
      req.url.pathname = '/handled_chat_preview_image_bypass';
    } else if (req.method === 'GET' && p === '/api/chat/upload') {
      await handleChatUploadInfo(req, res);
      req.url.pathname = '/handled_chat_upload_info_bypass';
    } else if (req.method === 'DELETE' && deleteMatch) {
      await handleChatUploadDelete(req, res, deleteMatch[1]);
      req.url.pathname = '/handled_chat_upload_delete_bypass';
    } else if ((req.method === 'GET' || req.method === 'HEAD') && serveMatch) {
      await handleChatUploadServe(req, res, serveMatch[1]);
      req.url.pathname = '/handled_chat_upload_serve_bypass';
    }
  });

  tpl.views = "views";
  tpl.debug = true;
  tpl.cache = false;

  // i18n — load active language from config (default: 'en')
  const { t, lang } = createI18n(cfg.websrv.language || 'en');

  // Get git commit hash for debug display
  let gitHash = process.env.GIT_HASH || 'unknown';
  if (gitHash === 'unknown') {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      gitHash = `${branch}-${hash}`;
    } catch (e) {
      // Not a git repository
    }
  }
  console.log('Git hash:', gitHash);

  // Fetch MOTD from database with retry logic
  let motdLoaded = false;
  let attempts = 0;
  const maxAttempts = 10;

  while (!motdLoaded && attempts < maxAttempts) {
    try {
      attempts++;
      const settings = await db`SELECT value FROM site_settings WHERE key = 'motd' LIMIT 1`;
      if (settings.length > 0) {
        setMotd(settings[0].value);
        console.log(`[BOOT] MOTD loaded on attempt ${attempts}`);
      } else {
        console.log(`[BOOT] No MOTD found in database (attempt ${attempts})`);
      }
      motdLoaded = true;
    } catch (e) {
      console.warn(`[BOOT] MOTD fetch failed (attempt ${attempts}):`, e.message);
      if (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
      }
    }
  }

  if (!motdLoaded) {
    console.error('[BOOT] MOTD failed to load after maximum attempts');
  }

  // Fetch Manual Approval setting
  try {
    const approvalSetting = await db`SELECT value FROM site_settings WHERE key = 'manual_approval' LIMIT 1`;
    if (approvalSetting.length > 0) {
      setManualApproval(approvalSetting[0].value === 'true');
      console.log(`[BOOT] Manual Approval setting loaded: ${getManualApproval()}`);
    } else {
      console.log(`[BOOT] No Manual Approval setting found, defaulting to false`);
      setManualApproval(false);
    }
  } catch (e) {
    console.warn(`[BOOT] Manual Approval fetch failed:`, e.message);
  }

  // Fetch min_tags setting
  try {
    const mtSetting = await db`SELECT value FROM site_settings WHERE key = 'min_tags' LIMIT 1`;
    if (mtSetting.length > 0) {
      setMinTags(parseInt(mtSetting[0].value));
      console.log(`[BOOT] Min Tags setting loaded: ${getMinTags()}`);
    } else {
      console.log(`[BOOT] No Min Tags setting found, defaulting to 0`);
      setMinTags(0); // Match default in settings.mjs
    }
  } catch (e) {
    console.warn(`[BOOT] Min Tags fetch failed:`, e.message);
  }

  // Fetch registration_open setting
  try {
    const regSetting = await db`SELECT value FROM site_settings WHERE key = 'registration_open' LIMIT 1`;
    if (regSetting.length > 0) setRegistrationOpen(regSetting[0].value === 'true');
  } catch (e) {
    console.warn(`[BOOT] Registration Open fetch failed:`, e.message);
  }

  // Fetch trusted_uploads setting
  try {
    const tuSetting = await db`SELECT value FROM site_settings WHERE key = 'trusted_uploads' LIMIT 1`;
    if (tuSetting.length > 0) {
      setTrustedUploads(parseInt(tuSetting[0].value));
      console.log(`[BOOT] Trusted Uploads setting loaded: ${getTrustedUploads()}`);
    } else {
      console.log(`[BOOT] No Trusted Uploads setting found, defaulting to ${getTrustedUploads()}`);
    }
  } catch (e) {
    console.warn(`[BOOT] Trusted Uploads fetch failed:`, e.message);
  }

  // Fetch brand_image_url setting (DB overrides config.yaml, which is never written at runtime)
  try {
    const biSetting = await db`SELECT value FROM site_settings WHERE key = 'brand_image_url' LIMIT 1`;
    if (biSetting.length > 0) {
      setBrandImageUrl(biSetting[0].value);
      console.log(`[BOOT] Brand image URL loaded from DB: ${getBrandImageUrl()}`);
    } else {
      console.log(`[BOOT] No brand image URL in DB, using config default: ${getBrandImageUrl()}`);
    }
  } catch (e) {
    console.warn(`[BOOT] Brand image URL fetch failed:`, e.message);
  }

  // Set enable_pdf from config (pure config setting)
  setEnablePdf(!!cfg.enable_pdf);
  console.log(`[BOOT] Enable PDF setting: ${getEnablePdf()}`);

  // IP logging settings are strictly config-based
  console.log(`[BOOT] Log User IPs: ${getLogUserIps()}`);
  console.log(`[BOOT] Hash User IPs: ${getHashUserIps()}`);

  // Fetch enable_cleanup, cleanup_start_date, and cleanup_end_date setting
  try {
    const ecSetting = await db`SELECT value FROM site_settings WHERE key = 'enable_cleanup' LIMIT 1`;
    if (ecSetting.length > 0) {
      setEnableCleanup(ecSetting[0].value === 'true');
    } else {
      setEnableCleanup(!!cfg.websrv.enable_cleanup);
    }
    console.log(`[BOOT] Enable Cleanup: ${getEnableCleanup()}`);

    const startSetting = await db`SELECT value FROM site_settings WHERE key = 'cleanup_start_date' LIMIT 1`;
    if (startSetting.length > 0) {
      setCleanupStartDate(startSetting[0].value);
    }
    console.log(`[BOOT] Cleanup Start Date: ${getCleanupStartDate()}`);

    const endSetting = await db`SELECT value FROM site_settings WHERE key = 'cleanup_end_date' LIMIT 1`;
    if (endSetting.length > 0) {
      setCleanupEndDate(endSetting[0].value);
    }
    console.log(`[BOOT] Cleanup End Date: ${getCleanupEndDate()}`);

    const engagedSetting = await db`SELECT value FROM site_settings WHERE key = 'cleanup_include_engaged' LIMIT 1`;
    if (engagedSetting.length > 0) {
      setCleanupIncludeEngaged(engagedSetting[0].value === 'true');
    }
    console.log(`[BOOT] Cleanup Include Engaged: ${getCleanupIncludeEngaged()}`);
  } catch (e) {
    console.warn(`[BOOT] Cleanup settings fetch failed:`, e.message);
    setEnableCleanup(!!cfg.websrv.enable_cleanup);
  }

  // Load bypass_duplicate_check from config.yaml (static — not a DB setting)
  if (cfg.websrv.bypass_duplicate_check === true) {
    setBypassDuplicateCheck(true);
    console.log(`[BOOT] Duplicate check bypass ENABLED via config.yaml`);
  }

  // Load protect_files from config.yaml (static — not a DB setting)
  if (cfg.websrv.protect_files === true) {
    setProtectFiles(true);
    console.log(`[BOOT] File protection ENABLED via config.yaml — direct file links require login`);
  }

  // Load active private items into memory cache
  await initPrivateItems();

  // Load private_messages from config.yaml (static — not a DB setting)
  // Default is true; set to false to fully disable private messaging
  setPrivateMessages(cfg.websrv.private_messages !== false);
  console.log(`[BOOT] Private messaging: ${cfg.websrv.private_messages !== false ? 'ENABLED' : 'DISABLED'}`);

  // Load dm_attachments from config.yaml (static — not a DB setting)
  // Default is true; requires private_messages to also be enabled
  setDmAttachments(cfg.websrv.dm_attachments !== false);
  console.log(`[BOOT] DM attachments: ${cfg.websrv.dm_attachments !== false ? 'ENABLED' : 'DISABLED'}`); 

  // Load dm_unencrypted from config.yaml (static — not a DB setting)
  setDmUnencrypted(!!cfg.websrv.dm_unencrypted);
  console.log(`[BOOT] DM unencrypted: ${cfg.websrv.dm_unencrypted ? 'ENABLED' : 'DISABLED'}`);
  // Load default_layout from config.yaml (static)
  if (cfg.websrv.default_layout) {
    setDefaultLayout(cfg.websrv.default_layout);
    console.log(`[BOOT] Default layout set to: ${getDefaultLayout()}`);
  }

  // Fetch about_text from database
  try {
    const aboutSetting = await db`SELECT value FROM site_settings WHERE key = 'about_text' LIMIT 1`;
    if (aboutSetting.length > 0) {
      setAboutText(aboutSetting[0].value);
      console.log(`[BOOT] About text loaded`);
    }
  } catch (e) {
    console.warn(`[BOOT] About text fetch failed:`, e.message);
  }

  // Fetch rules_text from database
  try {
    const rulesSetting = await db`SELECT value FROM site_settings WHERE key = 'rules_text' LIMIT 1`;
    if (rulesSetting.length > 0) {
      setRulesText(rulesSetting[0].value);
      console.log(`[BOOT] Rules text loaded`);
    }
  } catch (e) {
    console.warn(`[BOOT] Rules text fetch failed:`, e.message);
  }

  // Fetch terms_text from database
  try {
    const termsSetting = await db`SELECT value FROM site_settings WHERE key = 'terms_text' LIMIT 1`;
    if (termsSetting.length > 0) {
      setTermsText(termsSetting[0].value);
      console.log(`[BOOT] Terms text loaded`);
    }
  } catch (e) {
    console.warn(`[BOOT] Terms text fetch failed:`, e.message);
  }

  // Fetch nsfp (NSFP tag IDs) setting — overrides config.yaml if set in DB
  try {
    const nsfpSetting = await db`SELECT value FROM site_settings WHERE key = 'nsfp' LIMIT 1`;
    if (nsfpSetting.length > 0) {
      const parsed = JSON.parse(nsfpSetting[0].value);
      if (Array.isArray(parsed)) {
        setNsfpIds(parsed);
        console.log(`[BOOT] NSFP tag IDs loaded from DB: [${getNsfpIds().join(', ')}]`);
      }
    } else {
      console.log(`[BOOT] No NSFP setting in DB, using config.yaml: [${getNsfpIds().join(', ')}]`);
    }
  } catch (e) {
    console.warn(`[BOOT] NSFP setting fetch failed:`, e.message);
  }

  // Ensure all items in database have a unique slug backfilled
  ensureAllItemsHaveSlugs();
  ensureAllAlbumItemsHaveSlugs();

  const globals = {
    lul: cfg.websrv.lul,
    themes: cfg.websrv.themes,
    default_theme: cfg.websrv.theme || 'f0ck',
    modes: cfg.allowedModes,
    api: cfg.websrv.api,
    site: cfg.main.url.full,
    domain: cfg.main.url.domain,
    hide_comments_from_public: cfg.main.hide_comments_from_public,
    guest_anonymize: !!cfg.main.guest_anonymize,
    anon_anonymize: false,
    is_anonymized: false,
    git_hash: typeof gitHash !== 'undefined' ? gitHash : 'unknown',
    get motd() { return getMotd(); },
    get manual_approval() { return getManualApproval(); },
    get min_tags() { return getMinTags(); },
    get registration_open() { return getRegistrationOpen(); },
    // 'off' | 'hashed' | 'raw' — how IPs are persisted (security.storableIP); used for privacy disclosures
    get hw_fingerprint_enabled() { return getHwFingerprintEnabled(); },
    get privacy_ip_mode() { return !cfg.websrv.log_user_ips ? 'off' : (cfg.websrv.hash_user_ips ? 'hashed' : 'raw'); },
    registration_web_toggle_enabled: cfg.websrv.open_registration_web_toggle !== false,
    registration_require_mail_andor_token: !!cfg.websrv.open_registration_require_mail_andor_token,
    get trusted_uploads() { return getTrustedUploads(); },
    get shitpost_mode() { return getShitpostMode(); },
    shitpost_require_rating: !!cfg.websrv.shitpost_require_rating,
    shitpost_min_tags: parseInt(cfg.websrv.shitpost_min_tags) || 0,
    get about_text() { return getAboutText(); },
    get rules_text() { return getRulesText(); },
    get terms_text() { return getTermsText(); },
    get about_text_b64() { return Buffer.from(getAboutText() || '').toString('base64'); },
    get rules_text_b64() { return Buffer.from(getRulesText() || '').toString('base64'); },
    get terms_text_b64() { return Buffer.from(getTermsText() || '').toString('base64'); },
    get halls() { return getHalls(); },
    // Square Clicker: on unless websrv.square_clicker_enabled is false (resolved per request in render below)
    square_clicker_active: false,
    halls_enabled: cfg.websrv.halls_enabled !== false,
    userhalls_enabled: cfg.websrv.userhalls_enabled !== false,
    enable_userhall_image_upload: cfg.websrv.enable_userhall_image_upload !== false,
    enable_oc: cfg.websrv.enable_oc !== false,
    abyss_enabled: cfg.websrv.abyss_enabled !== false,
    smtp_enabled: !!(cfg.smtp && cfg.smtp.enabled && cfg.smtp.mail_reset_password),
    recaptcha_enabled: !!(cfg.recaptcha && cfg.recaptcha.enabled && cfg.recaptcha.site_key),
    recaptcha_site_key: (cfg.recaptcha && cfg.recaptcha.site_key) || '',
    show_background_cfg: cfg.websrv.background !== false,
    allowed_mimes: Object.keys(cfg.mimes).concat([...new Set(Object.values(cfg.mimes))].map(ext => `.${ext}`)).join(','),
    mimes_json: JSON.stringify(cfg.mimes),
    development: cfg.main.development || false,
    show_mime_picker: cfg.websrv.show_mime_picker !== false,
    private_society: cfg.websrv.private_society || false,
    private_society_gate: cfg.websrv.private_society_gate || '',
    private_society_gate_location: cfg.websrv.private_society_gate_location || 'Frankfurt',
    show_content_warning: cfg.websrv.show_content_warning !== false,
    web_url_upload: !!cfg.websrv.web_url_upload,
    enable_youtube_upload: cfg.websrv.enable_youtube_upload !== false,
    upload_limit: cfg.main.upload_limit ?? 69,
    meme_creator: !!cfg.websrv.meme_creator,
    custom_favicon: cfg.websrv.custom_favicon || "",
    get custom_brand_image() { return getBrandImageUrl(); },
    custom_navbar_brand_text: cfg.websrv.custom_navbar_brand_text || "",
    default_font: cfg.websrv.default_font || "",
    site_description: cfg.websrv.description || "The webs dumpster",
    enable_nsfl: !!cfg.enable_nsfl,
    enable_comments: cfg.enable_comments !== false,
    public_nsfw: !!cfg.websrv.public_nsfw,
    public_untagged: !!cfg.websrv.public_untagged,
    get onara() {
      const c = cfg.onara !== undefined ? cfg.onara : cfg.websrv?.onara;
      return !!c;
    },
    // onara_cfg would lock the per-user setting; config `onara` is only a default, so it never does.
    onara_cfg: null,
    is_onara_item: false,
    can_extract_meta: false,
    enable_private_uploads: cfg.enable_private_uploads !== false,
    get enable_expiring_uploads() { return getEnableExpiringUploads(); },
    get enable_item_slugs() { return getEnableItemSlugs(); },
    get enable_anonymous_access() { return getEnableAnonymousAccess(); },
    get anon_permissions() { return getAnonPermissions(); },
    get anon_permissions_json() { return JSON.stringify(getAnonPermissions()); },
    default_upload_visibility: (typeof cfg.default_upload_visibility === 'number' ? cfg.default_upload_visibility : (typeof cfg.websrv?.default_upload_visibility === 'number' ? cfg.websrv.default_upload_visibility : 0)),
    allow_user_upload_visibility: cfg.allow_user_upload_visibility !== false && cfg.websrv?.allow_user_upload_visibility !== false,
    nsfl_tag_id: cfg.nsfl_tag_id || 3,
    scroller_mime_cats: Array.isArray(cfg.allowedMimes) ? cfg.allowedMimes.filter(c => ['video','image','audio'].includes(c)) : ['video','image','audio'],
    themes_json: JSON.stringify(cfg.websrv.themes || []),
    audio_tuner_json: JSON.stringify(cfg.audio_tuner || cfg.audio_visualizer || cfg.websrv?.audio_tuner || null),
    enable_profile_description: !!cfg.websrv.enable_profile_description,
    expose_repost_links_to_guests: !!(cfg.websrv.expose_repost_links_to_guests || cfg.websrv.expose_repost_links),
    get private_messages() { return getPrivateMessages(); },
    get dm_attachments()    { return getDmAttachments(); },
    get dm_unencrypted()    { return getDmUnencrypted(); },
    get allow_comment_deletion() { return getAllowCommentDeletion(); },
    get enable_pdf() { return getEnablePdf(); },
    get enable_cleanup() { return getEnableCleanup(); },
    get cleanup_start_date() { return getCleanupStartDate(); },
    get cleanup_end_date() { return getCleanupEndDate(); },
    get cleanup_include_engaged() { return getCleanupIncludeEngaged(); },
    matrix_enabled: cfg.clients.find(c => c.type === 'matrix')?.enabled || false,
    telegram_enabled: cfg.clients.find(c => c.type === 'tg')?.enabled || false,
    get ts() { return Date.now(); },
    get default_layout() { return getDefaultLayout(); },
    show_koepfe: !!cfg.websrv.show_koepfe,
    hide_sidebar_default: !!cfg.websrv.hide_sidebar_default,
    allow_language_change: cfg.websrv.allow_language_change !== false,
    enable_xd_score: !!cfg.websrv.enable_xd_score,
    enable_dynamic_thumbs: !!cfg.websrv.enable_dynamic_thumbs,
    default_thumb_size: (() => { const v = (cfg.websrv.default_thumb_size || '').toLowerCase(); return ['s', 'm', 'l', 'xl'].includes(v) ? v : 'm'; })(),
    comment_max_length: cfg.main.comment_max_length ?? null,
    enable_swf: !!cfg.websrv.enable_swf,
    enable_archive: !!cfg.websrv.enable_archive,
    enable_danmaku: cfg.websrv.enable_danmaku !== false,
    enable_item_title: cfg.websrv.enable_item_title !== false,
    enable_global_chat: !!cfg.websrv.enable_global_chat,
    embed_youtube_in_comments: cfg.websrv.embed_youtube_in_comments !== false,
    get koepfe_json() {
      try {
        const kDir = cfg.paths.koepfe;
        if (!fs.existsSync(kDir)) return JSON.stringify(cfg.websrv.koepfe || []);
        const files = fs.readdirSync(kDir).filter(f => /\.(png|jpe?g|gif|webp|avif)$/i.test(f)).map(f => '/s/koepfe/' + f);
        return JSON.stringify(files.length ? files : (cfg.websrv.koepfe || []));
      } catch (e) {
        return JSON.stringify(cfg.websrv.koepfe || []);
      }
    },
    get custom_brand_images_json() {
      const current = getBrandImageUrl();
      if (current) {
        if (Array.isArray(cfg.websrv.custom_brand_image) && cfg.websrv.custom_brand_image.length > 1 && cfg.websrv.custom_brand_image.includes(current)) {
          return JSON.stringify(cfg.websrv.custom_brand_image);
        }
        return JSON.stringify([current]);
      }
      return JSON.stringify([]);
    },
    allowed_comment_images: cfg.websrv.allowed_comment_images || [],
    allowed_comment_images_json: JSON.stringify(cfg.websrv.allowed_comment_images || []),
    paths_images: cfg.websrv.paths?.images || '/b',
    default_comment_display_mode: cfg.websrv.default_comment_display_mode || 0,
    allow_fileupload_comments: cfg.websrv.allow_fileupload_comments || false,
    fileupload_comments_multifile: cfg.websrv.fileupload_comments_multifile || false,
    fileupload_comments_size: cfg.websrv.fileupload_comments_size || (10 * 1024 * 1024),
    fileupload_comments_max: cfg.websrv.fileupload_comments_max || 5,
    fileupload_comments_mode: cfg.websrv.fileupload_comments_mode || 'attachment',
    fileupload_comments_mimes: Array.isArray(cfg.websrv.fileupload_comments_mimes) ? cfg.websrv.fileupload_comments_mimes : ['image', 'video', 'audio'],
    enable_comment_polls: cfg.websrv.enable_comment_polls || false,

    get fonts() {
      try {
        const fontsDir = cfg.paths.fonts;
        if (!fs.existsSync(fontsDir)) return [];
        return fs.readdirSync(fontsDir).filter(f => /\.(ttf|otf|woff2?)$/i.test(f)).map(f => ({
          name: f.split('.').shift(),
          file: f
        }));
      } catch (e) {
        return [];
      }
    },

    // i18n
    t,
    lang
  };

  tpl.globals = globals;

  // Monkey-patch render to ensure mode and theme are passed
  const originalRender = tpl.render;
  const defaultI18n = { t, lang };
  tpl.render = function (view, data, req) {
    // Resolve per-request language BEFORE building data, so the correct
    // t() and lang are available from the start (not overridden by globals).
    let perRequestT = t;
    let perRequestLang = lang;

    if (req) {
      const VALID_LANGS = ['en', 'de', 'nl', 'zange'];
      const rawLang = (req.session?.language && req.session.language.trim())
        || (req.cookies?.language && req.cookies.language.trim())
        || cfg.websrv.language || 'en';
      const userLang = VALID_LANGS.includes(rawLang) ? rawLang : (cfg.websrv.language || 'en');
      const perRequest = createI18n(userLang);
      perRequestT = perRequest.t;
      perRequestLang = perRequest.lang;
      if (process.env.NODE_ENV !== 'production')
        console.log(`[i18n] render: user=${req.session?.user} rawLang=${rawLang} userLang=${userLang}`);
    } else if (data && data.t && data.lang) {
      // Called from @include — inherit values from the parent render's data
      perRequestT = data.t;
      perRequestLang = data.lang;
      if (typeof data.user_alternative_infobox === 'boolean') {
        // Inherit if already resolved in parent
      }
    }

    // Resolve per-request recaptcha preference (disabled for .onion requests or when passed false)
    const effectiveReq = req || (data && data.req);
    const defaultRecaptcha = !!(cfg.recaptcha && cfg.recaptcha.enabled && cfg.recaptcha.site_key);
    let perRequestRecaptcha = defaultRecaptcha;

    if (effectiveReq && (lib.isOnionRequest(effectiveReq) || lib.isLocalhostRequest(effectiveReq))) {
      perRequestRecaptcha = false;
    } else if (data && typeof data.recaptcha_enabled === 'boolean') {
      perRequestRecaptcha = data.recaptcha_enabled;
    }

    // Build data: globals first, then caller-supplied data, then per-request i18n last
    // so t/lang always reflect the user's language, not the site default.
    // ALSO mutate globals.t, globals.lang, globals.recaptcha_enabled: flummpress spreads this.#globals LAST
    // inside render(), so globals must carry the per-request values too.
    globals.t = perRequestT;
    globals.lang = perRequestLang;
    globals.recaptcha_enabled = perRequestRecaptcha;
    globals.is_onara_item = !!(data && data.is_onara_item);
    globals.onara_item_html = (data && data.onara_item_html) || '';

    // Resolve per-request infobox preference
    const activeReq = req || effectiveReq;
    const useAltInfobox = (activeReq && activeReq.session && typeof activeReq.session.use_alternative_infobox === 'boolean') 
      ? activeReq.session.use_alternative_infobox 
      : (data && typeof data.user_alternative_infobox === 'boolean'
        ? data.user_alternative_infobox
        : (cfg.websrv.user_alternative_infobox !== false));

    const useAltSteuerung = (activeReq && activeReq.session && typeof activeReq.session.use_alternative_steuerung === 'boolean')
      ? activeReq.session.use_alternative_steuerung
      : (data && typeof data.user_alternative_steuerung === 'boolean'
        ? data.user_alternative_steuerung
        : (cfg.websrv.user_alternative_steuerung !== false));

    const activeSession = activeReq?.session || data?.session || null;
    const isAnonymized = isAnonymizeSession(activeSession);
    const anonAnonymize = getAnonAnonymize();
    const canChan = canUseChan(activeSession);
    if (activeSession && typeof activeSession === 'object') {
      activeSession.can_chan = canChan;
    }
    if (data && data.item && typeof data.item.size === 'number') {
      data.item.size = lib.formatSize(data.item.size);
    }

    data = Object.assign({}, globals, data || {}, {
      t: perRequestT,
      lang: perRequestLang,
      recaptcha_enabled: perRequestRecaptcha,
      is_anonymized: isAnonymized,
      anon_anonymize: anonAnonymize,
      can_chan: canChan,
      // Item partials read can_rate_item; routes that only set can_manage_item fall back to it
      can_rate_item: !!(data && (data.can_rate_item ?? data.can_manage_item)),
      // Moderator-area page (/mod…): the back bar points to the moderator dashboard instead of /admin
      // Includes are rendered without req; keep the value the page render already computed
      is_mod_area: (data && typeof data.is_mod_area === 'boolean')
        ? data.is_mod_area
        : !!(activeReq?.url?.pathname && /^\/mod(\/|$)/.test(activeReq.url.pathname)),
      item_has_dimensions: !!(data && data.item && data.item.width && data.item.height),
      user_alternative_infobox: useAltInfobox,
      user_alternative_steuerung: useAltSteuerung,
      user_banner_enabled: cfg.websrv.user_banner_enabled !== false,
      comment_banner_enabled: (cfg.websrv.user_banner_enabled !== false) && (cfg.websrv.comment_banner_enabled !== false),
      comment_banner_max_height: typeof cfg.websrv.comment_banner_max_height === 'number' ? cfg.websrv.comment_banner_max_height : 300,
      comment_display_mode: (activeReq && activeReq.session && typeof activeReq.session.comment_display_mode === 'number')
        ? activeReq.session.comment_display_mode
        : (data && typeof data.comment_display_mode === 'number'
          ? data.comment_display_mode
          : (cfg.websrv.default_comment_display_mode || 0))
    });
    globals.is_anonymized = isAnonymized;
    globals.anon_anonymize = anonAnonymize;

    // Brand image per-render — sourced from live in-memory setting (DB-backed, not config.yaml)
    const brandUrl = getBrandImageUrl();
    if (brandUrl) {
      data.custom_brand_image = brandUrl;
    }

    if (activeReq) {
      data.recaptcha_enabled = perRequestRecaptcha;
      if (activeReq.mode !== undefined) data.mode = activeReq.mode;
      data.theme = activeReq.theme || activeReq.cookies?.theme || cfg.websrv.theme || 'f0ck';
      if (!data.url) data.url = activeReq.url;
      data.user_strict_bool = (activeReq.session && activeReq.session.strict_mode) ? true : false;
      data.user_logged_in_bool = !!activeReq.session;
      data.csrf_token = activeReq.session?.csrf_token || data.csrf_token || '';
      globals.csrf_token = data.csrf_token;
      // Also on data: @include renders (the footer that loads square-clicker.js) run without a request and inherit it
      data.square_clicker_active = isSquareClickerActive(new Date(), activeReq.session);
      globals.square_clicker_active = data.square_clicker_active;
      data.max_file_size = lib.formatSize(cfg.main.maxfilesize * (activeReq.session?.admin ? cfg.main.adminmultiplier : 1));
      data.max_file_size_bytes = Math.floor(cfg.main.maxfilesize * (activeReq.session?.admin ? cfg.main.adminmultiplier : 1));
      data.web_url_upload = data.web_url_upload !== undefined ? data.web_url_upload : !!cfg.websrv.web_url_upload;

      // Onara is a per-user setting; config `onara` is only the default
      data.onara = isOnaraEnabledFor(activeReq);
      data.onara_cfg = null;
    } else {
      data.recaptcha_enabled = perRequestRecaptcha;
      data.theme = data.theme || cfg.websrv.theme || 'f0ck';
      data.user_strict_bool = false;
      data.user_logged_in_bool = false;
      globals.csrf_token = data.csrf_token || '';
      globals.square_clicker_active = (data && typeof data.square_clicker_active === 'boolean') ? data.square_clicker_active : isSquareClickerActive();

      const cfgOnara = cfg.onara !== undefined ? cfg.onara : cfg.websrv?.onara;
      data.onara = cfgOnara === true;
      data.onara_cfg = null;
    }

    return originalRender.call(tpl, view, data, (data.url && data.url !== req?.url) ? undefined : req);
  };

  router.use(tpl);
  router.self = self;

  await router.importRoutesFromPath("src/inc/routes", tpl);

  app.listen(cfg.websrv.port);

  // F-015 Security: Periodic session cleanup — purge sessions unused for 30 days
  const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
  const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

  const cleanupStaleSessions = async () => {
    try {
      const cutoff = ~~(Date.now() / 1e3) - SESSION_TTL_SECONDS;
      const result = await db`DELETE FROM user_sessions WHERE last_used <= ${cutoff}`;
      if (result.count > 0) {
        console.log(`[SESSION CLEANUP] Purged ${result.count} stale sessions (unused >30 days)`);
      }
    } catch (err) {
      console.error('[SESSION CLEANUP] Failed:', err.message);
    }
  };

  // Run once after startup (30s delay to let DB settle), then every 6 hours
  setTimeout(cleanupStaleSessions, 30_000);
  setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);

  // Expiring uploads background purge (every 30s)
  setTimeout(purgeExpiredUploads, 10_000);
  setInterval(purgeExpiredUploads, 30_000);


  // ── Inactivity ban — permanently ban accounts that haven't logged in for N days
  // Set websrv.inactivity_ban_days = 0 (or omit) to disable this feature entirely.
  const INACTIVITY_BAN_DAYS = parseInt(cfg.websrv.inactivity_ban_days) || 0;

  if (INACTIVITY_BAN_DAYS <= 0) {
    console.log(`[BOOT] Inactivity ban: DISABLED (set websrv.inactivity_ban_days > 0 to enable)`);
  } else {
    const INACTIVITY_BAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

    const banInactiveUsers = async () => {
      try {
        const cutoffSecs = ~~(Date.now() / 1e3) - INACTIVITY_BAN_DAYS * 24 * 60 * 60;

        // Find activated, non-banned, non-admin, non-moderator accounts whose
        // last_seen timestamp has passed the inactivity threshold.
        // Accounts with last_seen = 0 (never logged in) are also included.
        const targets = await db`
          SELECT id, login
          FROM "user"
          WHERE banned        = false
            AND activated     = true
            AND admin         = false
            AND is_moderator  = false
            AND login        != 'deleted_user'
            AND last_seen    <= ${cutoffSecs}
        `;

        if (targets.length === 0) return;

        const ids = targets.map(u => u.id);
        const reason = `Inactivity (no login for ${INACTIVITY_BAN_DAYS}+ days)`;

        await db`
          UPDATE "user"
          SET banned     = true,
              ban_reason = ${reason},
              ban_expires = NULL
          WHERE id = ANY(${ids})
        `;

        // Terminate all open sessions for banned accounts
        await db`DELETE FROM user_sessions WHERE user_id = ANY(${ids})`;

        console.log(`[INACTIVITY BAN] Banned ${targets.length} inactive account(s) (threshold: ${INACTIVITY_BAN_DAYS} days): ${targets.map(u => u.login).join(', ')}`);
      } catch (err) {
        console.error('[INACTIVITY BAN] Failed:', err.message);
      }
    };

    console.log(`[BOOT] Inactivity ban: enabled — threshold ${INACTIVITY_BAN_DAYS} days (config: websrv.inactivity_ban_days)`);

    // Run once after startup (60s delay to let DB settle), then every 6 hours
    setTimeout(banInactiveUsers, 60_000);
    setInterval(banInactiveUsers, INACTIVITY_BAN_INTERVAL_MS);
  }

  // ── Data retention — delete / scrub personal data after websrv.retention_*_days (shown on /privacy)
  startRetention();
  if (cfg.websrv.hash_user_ips) {
    const src = getIpHashSource();
    (src.startsWith('env') ? console.log : console.warn)(`[BOOT] IP hash secret: ${src}`);
  }

})();
