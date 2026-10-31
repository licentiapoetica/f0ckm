-- Add favorites_private column to user_options table
ALTER TABLE user_options
    ADD COLUMN IF NOT EXISTS favorites_private boolean DEFAULT false;

COMMENT ON COLUMN public.user_options.favorites_private IS 'When true, only the owner and administrators can view the user''s favorites list';
