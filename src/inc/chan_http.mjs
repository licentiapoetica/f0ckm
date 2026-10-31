/**
 * chan_http.mjs — curl invocation for all outgoing 4chan requests (API JSON, media, rehost downloads).
 *
 * Every call gets a randomized browser identity:
 *   - If curl-impersonate is installed (wrapper binaries like curl_chrome116, curl_ff117, ...), a random
 *     profile is used. These reproduce a real browser's TLS + HTTP/2 handshake and send matching headers,
 *     so we must NOT override the User-Agent (a mismatch would defeat the point).
 *   - Otherwise plain curl is used with a random, current User-Agent and a matching Accept-Language.
 *
 * config: main.curl_impersonate
 *   (unset) / true → auto-detect wrappers on PATH
 *   false          → never use curl-impersonate
 *   "<dir>"        → look for wrappers in that directory (in addition to PATH)
 */
import fs from 'fs';
import path from 'path';
import cfg from './config.mjs';

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Browser majors derived from the date so the pool never goes stale.
// Chrome 100 shipped 2022-03-29, Firefox 100 on 2022-05-03; both release every 4 weeks.
const majorSince = (base, isoDate) => base + Math.floor((Date.now() - Date.parse(isoDate)) / (28 * 86400000));

const randomUserAgent = () => {
  const chrome = majorSince(100, '2022-03-29') - Math.floor(Math.random() * 3); // current or up to 2 behind
  const firefox = majorSince(100, '2022-05-03') - Math.floor(Math.random() * 3);
  const templates = [
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`,
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`,
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`,
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`,
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36 Edg/${chrome}.0.0.0`,
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${firefox}.0) Gecko/20100101 Firefox/${firefox}.0`,
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${firefox}.0) Gecko/20100101 Firefox/${firefox}.0`,
    `Mozilla/5.0 (X11; Linux x86_64; rv:${firefox}.0) Gecko/20100101 Firefox/${firefox}.0`
  ];
  return pick(templates);
};

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9',
  'en-US,en;q=0.8',
  'en-GB,en;q=0.9,en-US;q=0.8',
  'en-US,en;q=0.9,de;q=0.8',
  'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
];

// ── curl-impersonate detection (cached after first lookup) ──────────────────
// Wrapper names look like curl_chrome146, curl_firefox147, curl_edge101, curl_safari260, curl_chrome131_android.
const IMPERSONATE_RE = /^curl_(chrome|edge|firefox|ff|safari)(\d+)([a-z0-9_]*)$/i;
// Only the newest desktop profiles per browser: an old fingerprint (chrome99) stands out as much as plain curl.
const PROFILES_PER_BROWSER = 3;
let _impersonateBins = null;

const findImpersonateBins = () => {
  if (_impersonateBins) return _impersonateBins;
  const setting = cfg.main?.curl_impersonate;
  if (setting === false) return (_impersonateBins = []);

  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (typeof setting === 'string' && setting.trim()) dirs.unshift(setting.trim());

  const byBrowser = new Map(); // family → [{ version, full }]
  const seen = new Set();
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const m = name.match(IMPERSONATE_RE);
      if (!m || m[3] || seen.has(name)) continue; // m[3] = suffix like _android/_ios/a → skip non-desktop variants
      const full = path.join(dir, name);
      try { fs.accessSync(full, fs.constants.X_OK); } catch { continue; }
      seen.add(name);
      const family = m[1].toLowerCase() === 'ff' ? 'firefox' : m[1].toLowerCase();
      if (!byBrowser.has(family)) byBrowser.set(family, []);
      byBrowser.get(family).push({ version: parseInt(m[2], 10), full });
    }
  }

  // Edge shares Chrome's version numbers; drop Edge profiles that lag far behind the newest Chrome
  // (releases have shipped edge99/edge101 next to chrome146, which would stand out as ancient).
  const newestChrome = Math.max(0, ...(byBrowser.get('chrome') || []).map(p => p.version));
  if (newestChrome && byBrowser.has('edge')) {
    byBrowser.set('edge', byBrowser.get('edge').filter(p => p.version >= newestChrome - 10));
  }

  _impersonateBins = [];
  for (const list of byBrowser.values()) {
    list.sort((a, b) => b.version - a.version);
    _impersonateBins.push(...list.slice(0, PROFILES_PER_BROWSER).map(p => p.full));
  }
  console.log(_impersonateBins.length
    ? `[BOOT] 4chan requests: curl-impersonate enabled (${_impersonateBins.map(b => path.basename(b)).join(', ')})`
    : '[BOOT] 4chan requests: curl-impersonate not found, using curl with randomized User-Agent');
  return _impersonateBins;
};

// The static curl-impersonate build looks for CAs at the Debian/Alpine path only. On other distros
// (openSUSE, Fedora, macOS) point it at the local bundle explicitly.
const CA_DEFAULT = '/etc/ssl/certs/ca-certificates.crt';
const CA_FALLBACKS = ['/etc/ssl/ca-bundle.pem', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem'];
let _caArgs = null;
const caArgs = () => {
  if (_caArgs) return _caArgs;
  if (fs.existsSync(CA_DEFAULT)) return (_caArgs = []);
  const found = CA_FALLBACKS.find(f => fs.existsSync(f));
  return (_caArgs = found ? ['--cacert', found] : []);
};

const socksArgs = () => {
  const socks = cfg.main?.socks;
  if (!socks || socks === 'undefined') return [];
  const host = socks.includes('://') ? socks.split('://')[1] : socks;
  return ['--socks5-hostname', host];
};

/**
 * Build a curl command for a 4chan URL with a randomized browser identity.
 * @param {string} url
 * @param {string[]} [extraArgs] additional curl flags (e.g. ['-o', file, '--max-time', '300'])
 * @returns {{ bin: string, args: string[] }}
 */
export const chanCurl = (url, extraArgs = []) => {
  const base = ['-s', '-f', '-L', ...extraArgs, ...socksArgs()];
  const impersonate = findImpersonateBins();
  if (impersonate.length) {
    // Wrapper supplies its own UA, header order and TLS/HTTP2 fingerprint
    return { bin: pick(impersonate), args: [...base, ...caArgs(), url] };
  }
  return {
    bin: 'curl',
    args: [...base, '-A', randomUserAgent(), '-H', `Accept-Language: ${pick(ACCEPT_LANGUAGES)}`, url]
  };
};

export default { chanCurl };
