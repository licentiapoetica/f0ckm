-- Migration: invite_requests
-- Tracks anonymous users requesting invite tokens from admins

CREATE TABLE IF NOT EXISTS public.invite_requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES public."user"(id) ON DELETE SET NULL,
    fingerprint VARCHAR(128) NOT NULL,
    ip_hash VARCHAR(128),
    reason TEXT DEFAULT '',
    status VARCHAR(16) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
    token_id INTEGER REFERENCES public.invite_tokens(id) ON DELETE SET NULL,
    reviewed_by INTEGER REFERENCES public."user"(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invite_requests_fingerprint ON public.invite_requests(fingerprint);
CREATE INDEX IF NOT EXISTS idx_invite_requests_status ON public.invite_requests(status);
CREATE INDEX IF NOT EXISTS idx_invite_requests_pending ON public.invite_requests(created_at) WHERE (status = 'pending');
