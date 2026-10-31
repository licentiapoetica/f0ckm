-- Migration: Add Hardware Fingerprint Banning
-- Adds banned_hardware_fingerprints table and links hw_fingerprint to anon_identities and anon_activity_log.

CREATE TABLE IF NOT EXISTS banned_hardware_fingerprints (
    id SERIAL PRIMARY KEY,
    hw_fingerprint VARCHAR(128) UNIQUE NOT NULL,
    banned_by INT REFERENCES "user"(id) ON DELETE SET NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_banned_hw_fp ON banned_hardware_fingerprints(hw_fingerprint);
CREATE INDEX IF NOT EXISTS idx_banned_hw_expires ON banned_hardware_fingerprints(expires_at);

-- Add hardware fingerprint column to anon_identities
ALTER TABLE anon_identities 
ADD COLUMN IF NOT EXISTS hw_fingerprint VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_anon_identities_hw ON anon_identities(hw_fingerprint);

-- Add hardware fingerprint column to anon_activity_log
ALTER TABLE anon_activity_log 
ADD COLUMN IF NOT EXISTS hw_fingerprint VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_anon_activity_hw ON anon_activity_log(hw_fingerprint);
