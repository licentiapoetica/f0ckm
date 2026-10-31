-- Migration: Add anonymous activity log and multi-layer anonymous banning tables

CREATE TABLE IF NOT EXISTS anon_activity_log (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  fingerprint VARCHAR(128),
  action VARCHAR(64) NOT NULL,
  target_id INT,
  ip VARCHAR(128) NOT NULL,
  user_agent TEXT,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anon_act_user_id ON anon_activity_log (user_id);
CREATE INDEX IF NOT EXISTS idx_anon_act_action ON anon_activity_log (action);
CREATE INDEX IF NOT EXISTS idx_anon_act_ip ON anon_activity_log (ip);
CREATE INDEX IF NOT EXISTS idx_anon_act_created ON anon_activity_log (created_at);

CREATE TABLE IF NOT EXISTS banned_ips (
  id SERIAL PRIMARY KEY,
  ip VARCHAR(128) NOT NULL UNIQUE,
  ip_hash VARCHAR(128),
  reason TEXT DEFAULT 'Banned by administrator',
  banned_by INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_banned_ips_ip ON banned_ips (ip);
CREATE INDEX IF NOT EXISTS idx_banned_ips_hash ON banned_ips (ip_hash);

CREATE TABLE IF NOT EXISTS banned_fingerprints (
  id SERIAL PRIMARY KEY,
  fingerprint VARCHAR(128) NOT NULL UNIQUE,
  pubkey TEXT,
  reason TEXT DEFAULT 'Banned by administrator',
  banned_by INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_banned_fp_fp ON banned_fingerprints (fingerprint);

ALTER TABLE comments ADD COLUMN IF NOT EXISTS ip VARCHAR(128);
ALTER TABLE items ADD COLUMN IF NOT EXISTS uploader_ip VARCHAR(128);
ALTER TABLE anon_identities ADD COLUMN IF NOT EXISTS created_ip VARCHAR(128);
ALTER TABLE anon_identities ADD COLUMN IF NOT EXISTS last_ip VARCHAR(128);
