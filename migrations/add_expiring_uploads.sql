-- Migration: Add expires_at column to items table for expiring uploads
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS expires_at bigint DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_items_expires_at ON public.items(expires_at) WHERE expires_at IS NOT NULL AND is_purged = false;
