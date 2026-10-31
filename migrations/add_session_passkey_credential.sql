-- Migration: remember which passkey opened a session
-- Set on passkey sign-in (registered and anonymous). The passkey a session is using can't be deleted
-- from that session, and the settings page marks it as "This session". NULL = password login or a
-- session from before this column existed.

ALTER TABLE public.user_sessions ADD COLUMN IF NOT EXISTS passkey_credential_id TEXT;
