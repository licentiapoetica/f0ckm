import crypto from "crypto";
import util from "util";
import db from "./sql.mjs";

import cfg from "./config.mjs";
import { createI18n } from "./i18n.mjs";



const scrypt = util.promisify(crypto.scrypt);

const epochs = [
  ["year", 31536000],
  ["month", 2592000],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1]
];
const getDuration = timeAgoInSeconds => {
  for (let [name, seconds] of epochs) {
    const interval = ~~(timeAgoInSeconds / seconds);
    if (interval >= 1) return {
      interval: interval,
      epoch: name
    };
  }
};

export default new class {
  escapeHTML(str) {
    if (!str) return "";
    return str.toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  formatSize(size, i = ~~(Math.log(size) / Math.log(1024))) {
    return (size / Math.pow(1024, i)).toFixed(2) * 1 + " " + ["B", "kB", "MB", "GB", "TB"][i];
  };
  calcSpeed(b, s) {
    return (Math.round((b * 8 / s / 1e6) * 1e4) / 1e4);
  };
  timeAgo(date, lang = 'en') {
    const { t } = createI18n(lang);
    const duration = getDuration(~~((new Date() - new Date(date)) / 1e3));
    if (!duration) return t('timeago.just_now');
    const { interval, epoch } = duration;
    const unitKey = interval === 1 ? `timeago.${epoch}` : `timeago.${epoch}s`;
    const timeStr = t(unitKey, { n: interval });
    return t('timeago.ago', { t: timeStr });
  };
  md5(str) {
    return crypto.createHash('md5').update(str).digest("hex");
  };
  sha256(str) {
    return crypto.createHash('sha256').update(str).digest("hex");
  };
  getMode(mode) {
    let tmp;
    mode = Number(mode);
    switch (mode) {
      case 1: // nsfw
        tmp = "items.id in (select item_id from tags_assign where tag_id = 2)";
        break;
      case 2: // untagged
        tmp = "not exists (select 1 from tags_assign where item_id = items.id)";
        break;
      case 3: // all
        tmp = "1 = 1";
        break;
      case 4: // nsfl
        tmp = cfg.enable_nsfl ? `items.id in (select item_id from tags_assign where tag_id = ${parseInt(cfg.nsfl_tag_id, 10) || 3})` : "1 = 0";
        break;
      default: // sfw
        tmp = "items.id in (select item_id from tags_assign where tag_id = 1)";
        break;
    }
    return tmp;
  };
  createID() {
    return crypto.randomBytes(16).toString("hex") + Date.now().toString(24);
  };
  generateToken() {
    return crypto.randomBytes(32).toString("hex");
  };
  genLink(env) {
    const link = [];
    if (env.tag) link.push("tag", encodeURIComponent(env.tag));
    if (env.hall) link.push("h", encodeURIComponent(env.hall));
    if (env.user) link.push("user", encodeURIComponent(env.user), env.type ?? 'uploads');

    let tmp = link.length === 0 ? '/' : link.join('/');
    if (!tmp.endsWith('/'))
      tmp = tmp + '/';
    if (!tmp.startsWith('/'))
      tmp = '/' + tmp;

    // Build suffix with query params
    let suffix = env.strict ? '?strict=1' : '';

    return {
      main: tmp,
      path: env.path ? env.path : '',
      suffix: suffix
    };
  };
  parseTag(tag) {
    if (!tag)
      return null;
    return decodeURIComponent(tag);
  }
  slugify(str) {
    if (!str) return "";
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Escape ILIKE wildcard characters in user-supplied strings
  escapeLike(str) {
    if (!str) return str;
    return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }

  // async funcs
  async countf0cks() {
    const tagged = +(await db`
      select count(*) as total
      from "items"
      where id in (select item_id from tags_assign group by item_id) and active = true
    `)[0].total;
    const untagged = +(await db`
      select count(*) as total
      from "items"
      where not exists (select 1 from tags_assign where item_id = items.id) and active = true
    `)[0].total;
    const sfw = +(await db`
      select count(*) as total
      from "items"
      where id in (select item_id from tags_assign where tag_id = 1 group by item_id) and active = true
    `)[0].total;
    const nsfw = +(await db`
      select count(*) as total
      from "items"
      where id in (select item_id from tags_assign where tag_id = 2 group by item_id) and active = true
    `)[0].total;
    const nsfl = cfg.enable_nsfl ? +(await db`
      select count(*) as total
      from "items"
      where id in (select item_id from tags_assign where tag_id = ${cfg.nsfl_tag_id || 3} group by item_id) and active = true
    `)[0].total : 0;
    const deleted = +(await db`
      select count(*) as total
      from "items"
      where active = false and is_deleted = true
    `)[0].total;
    const pending = +(await db`
      select count(*) as total
      from "items"
      where active = false and is_deleted = false
    `)[0].total;
    const lastf0ck = +(await db`
      select max(id) as id
      from "items"
    `)[0].id;
    return {
      tagged,
      untagged,
      total: tagged + untagged,
      deleted,
      pending,
      untracked: lastf0ck - (tagged + untagged + deleted + pending),
      sfw,
      nsfw,
      nsfl: cfg.enable_nsfl ? nsfl : 0,
    };
  };
  async hash(str) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derivedKey = await scrypt(str, salt, 64);
    return "$f0ck$" + salt + ":" + derivedKey.toString("hex");
  };
  async verify(str, hash) {
    if (typeof hash !== 'string') return false;

    if (hash.startsWith("$f0ck$")) {
      const parts = hash.substring(6).split(":");
      if (parts.length !== 2) return false;
      const [salt, key] = parts;
      try {
        const keyBuffer = Buffer.from(key, "hex");
        const derivedKey = await scrypt(str, salt, 64);
        return crypto.timingSafeEqual(keyBuffer, derivedKey);
      } catch (e) {
        return false;
      }
    }

    if (hash.length === 32) {
      return this.md5(str) === hash;
    }

    if (hash.length === 64) {
      return this.sha256(str) === hash;
    }

    return false;
  };
  async getTags(itemid) {
    const tags = await db`
      select "tags".id, "tags".tag, "tags".normalized, "user".user, uo.display_name
      from "tags_assign"
      left join "tags" on "tags".id = "tags_assign".tag_id
      left join "user" on "user".id = "tags_assign".user_id
      left join user_options uo on uo.user_id = "user".id
      where "tags_assign".item_id = ${+itemid}
      order by (case when "tags".id = 1 then 0 when "tags".id = 2 then 1 when "tags".id = ${cfg.nsfl_tag_id || 3} then 2 else 3 end) asc, "tags".id asc
    `;
    for (let t = 0; t < tags.length; t++) {
      tags[t].badge = this.getBadge(tags[t]);
    }
    return tags;
  };
  getBadge(tagObj) {
    if (tagObj.tag.startsWith(">"))
      return "badge-greentext badge-light";
    else if (tagObj.normalized === "ukraine")
      return "badge-ukraine badge-light";
    else if (/[а-яё]/.test(tagObj.normalized) || tagObj.normalized === "russia")
      return "badge-russia badge-light";
    else if (tagObj.normalized === "german")
      return "badge-german badge-light";
    else if (tagObj.normalized === "dutch")
      return "badge-dutch badge-light";
    else if (tagObj.normalized === "sfw")
      return "badge-success";
    else if (tagObj.normalized === "nsfw")
      return "badge-danger";
    else if (tagObj.normalized === "nsfl")
      return cfg.enable_nsfl ? "badge-nsfl" : "badge-light";
    else
      return "badge-light";
  };
  async hasTag(itemid, tagid) {
    const tag = (await db`
      select *
      from "tags_assign"
      where
        item_id = ${+itemid} and
        tag_id = ${+tagid}
      limit 1
    `).length;
    return !!tag;
  };
  // detectNSFW: removed — contained shell injection via exec() with unescaped `dest` parameter.
  // If re-implemented, use execFile() with argument arrays and a dedicated Python script.
  async getDefaultAvatar() {
    return (await db`
      select column_default as avatar
      from "information_schema"."columns"
      where
        TABLE_SCHEMA='public' and
        TABLE_NAME='user_options' and
        COLUMN_NAME = 'avatar'
    `)[0].avatar;
  };

  // meddlware admin
  async auth(req, res, next) {
    if (!req.session || !req.session.admin) {
      return res.reply({
        code: 401,
        body: "401 - Unauthorized"
      });
    }
    if (req.session.force_password_change && req.url.pathname !== '/api/v2/settings/password' && req.url.pathname !== '/logout') {
      return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: "Password change required", force_password_change: true }), type: 'application/json' });
    }
    return next();
  };
  
  // meddlware user
  async userauth(req, res, next) {
    if (!req.session) {
      return res.reply({
        code: 401,
        body: "401 - Unauthorized"
      });
    }
    if (req.session.force_password_change && req.url.pathname !== '/api/v2/settings/password' && req.url.pathname !== '/logout' && req.url.pathname !== '/settings') {
      return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: "Password change required", force_password_change: true }), type: 'application/json' });
    }
    return next();
  };
  
  async loggedin(req, res, next) {
    if (!req.session) {
      return res.reply({
        code: 401,
        body: "401 - Unauthorized"
      });
    }
    if (req.session.force_password_change && req.url.pathname !== '/api/v2/settings/password' && req.url.pathname !== '/logout') {
      return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: "Password change required", force_password_change: true }), type: 'application/json' });
    }
    return next();
  };

  async modAuth(req, res, next) {
    if (!req.session || (!req.session.admin && !req.session.is_moderator)) {
      return res.reply({
        code: 401,
        body: "401 - Unauthorized"
      });
    }
    if (req.session.force_password_change && req.url.pathname !== '/api/v2/settings/password' && req.url.pathname !== '/logout') {
      return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: "Password change required", force_password_change: true }), type: 'application/json' });
    }
    return next();
  };

  async adminAuth(req, res, next) {
    if (!req.session || !req.session.admin) {
      return res.reply({
        code: 401,
        body: "401 - Unauthorized"
      });
    }
    if (req.session.force_password_change && req.url.pathname !== '/api/v2/settings/password' && req.url.pathname !== '/logout') {
      return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: "Password change required", force_password_change: true }), type: 'application/json' });
    }
    return next();
  };

  getCookieOptions(expires = null, httpOnly = true) {
    const isSecure = cfg.main.url.full && cfg.main.url.full.startsWith('https');
    let options = "Path=/; SameSite=Lax";
    if (httpOnly) options += "; HttpOnly";
    if (isSecure) options += "; Secure";
    if (expires) {
      if (typeof expires === 'number') {
        options += `; Max-Age=${expires}`;
      } else {
        options += `; Expires=${expires}`;
      }
    }
    this.debug(`[COOKIE DEBUG] full=${cfg.main.url.full}, isSecure=${isSecure}, options=${options}`);
    return options;
  }

  debug(...args) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(...args);
    }
  }

  logError(err, context = "Internal Error") {
    const errId = crypto.randomUUID();
    console.error(`[ERROR REF ${errId}] ${context}:`, err);
    return `Internal Error. Reference: ${errId}`;
  }
};
