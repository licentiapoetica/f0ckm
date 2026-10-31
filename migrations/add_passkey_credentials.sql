-- passkey_credentials: stores WebAuthn credential records for all users
-- (both registered accounts and anonymous shadow users)
CREATE TABLE IF NOT EXISTS public.passkey_credentials (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,        -- base64url-encoded credentialId
    public_key_spki TEXT NOT NULL,             -- base64-encoded DER SPKI (ES-256 / P-256)
    sign_count BIGINT NOT NULL DEFAULT 0,      -- replay-attack counter
    aaguid TEXT,                               -- authenticator AAGUID (informational)
    name TEXT,                                 -- user-assigned label ("Bitwarden", "iPhone")
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_passkey_credential_id ON public.passkey_credentials(credential_id);
CREATE INDEX IF NOT EXISTS idx_passkey_user_id      ON public.passkey_credentials(user_id);

-- Extend anon_identities to support passkey-based identities.
-- New passkey rows use credential_id; legacy SSH rows retain pubkey/fingerprint.
-- pubkey and fingerprint are made nullable to allow passkey-only rows.
ALTER TABLE public.anon_identities
    ADD COLUMN IF NOT EXISTS credential_id TEXT UNIQUE;

ALTER TABLE public.anon_identities
    ALTER COLUMN pubkey     DROP NOT NULL;

ALTER TABLE public.anon_identities
    ALTER COLUMN fingerprint DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_anon_identities_credential_id
    ON public.anon_identities(credential_id);
