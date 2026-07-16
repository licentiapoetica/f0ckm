-- Add banner_file column to user_options for custom profile banners
-- Banners are displayed in the alternative infobox (user-infobox-block)

ALTER TABLE user_options
    ADD COLUMN IF NOT EXISTS banner_file character varying(255) DEFAULT NULL;

COMMENT ON COLUMN public.user_options.banner_file IS 'Custom uploaded banner image filename, stored in public/a/ (same dir as avatars)';
