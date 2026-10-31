-- Migration: Add sticker_packs table and link custom_emojis to packs
-- Run this against the f0ckm database (idempotent — safe to run multiple times)

-- Create sticker_packs table
CREATE TABLE IF NOT EXISTS public.sticker_packs (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    tg_name     text UNIQUE,
    tg_title    text,
    thumb_url   text,
    sticker_count integer DEFAULT 0,
    created_at  timestamp with time zone DEFAULT now()
);

ALTER TABLE public.sticker_packs OWNER TO f0ckm;

-- Add pack_id column to custom_emojis (nullable: NULL = standalone emoji, no pack)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'custom_emojis'
          AND column_name  = 'pack_id'
    ) THEN
        ALTER TABLE public.custom_emojis
            ADD COLUMN pack_id integer REFERENCES public.sticker_packs(id) ON DELETE SET NULL;
        RAISE NOTICE 'pack_id column added to custom_emojis';
    ELSE
        RAISE NOTICE 'pack_id column already exists on custom_emojis — skipping';
    END IF;
END
$$;

-- Add thumb_url column to sticker_packs if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'sticker_packs'
          AND column_name  = 'thumb_url'
    ) THEN
        ALTER TABLE public.sticker_packs ADD COLUMN thumb_url text;
        RAISE NOTICE 'thumb_url column added to sticker_packs';
    ELSE
        RAISE NOTICE 'thumb_url already exists on sticker_packs — skipping';
    END IF;
END
$$;

-- Index for fast pack lookups
CREATE INDEX IF NOT EXISTS custom_emojis_pack_id_idx ON public.custom_emojis (pack_id);
