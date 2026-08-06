-- Add hide_fav_badge column to user_options table
ALTER TABLE user_options
    ADD COLUMN IF NOT EXISTS hide_fav_badge boolean DEFAULT false;

COMMENT ON COLUMN public.user_options.favorites_private IS 'When true, the user''s favorite badge on item pages displays as a ghost icon without linking to their profile';
