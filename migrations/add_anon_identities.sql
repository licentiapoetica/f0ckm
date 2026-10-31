CREATE TABLE IF NOT EXISTS public.anon_identities (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    pubkey TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anon_identities_pubkey ON public.anon_identities(pubkey);
CREATE INDEX IF NOT EXISTS idx_anon_identities_fingerprint ON public.anon_identities(fingerprint);
CREATE INDEX IF NOT EXISTS idx_anon_identities_user_id ON public.anon_identities(user_id);
