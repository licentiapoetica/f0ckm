-- Migration: temporary chat file hosting for external clients
CREATE TABLE IF NOT EXISTS public.upload_api_keys (
    id serial PRIMARY KEY,
    name text NOT NULL,
    key_hash text NOT NULL UNIQUE,
    max_bytes bigint DEFAULT NULL,
    revoked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.chat_uploads (
    id bigserial PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    key_id integer REFERENCES public.upload_api_keys(id) ON DELETE SET NULL,
    original_name text DEFAULT ''::text NOT NULL,
    mime text NOT NULL,
    mime_hint text DEFAULT ''::text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    delete_token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_uploads_expires_at ON public.chat_uploads(expires_at);
