-- Add banner_file column to user_options for custom profile banners
-- Banners are displayed in the alternative infobox (user-infobox-block)

ALTER TABLE user_options
    ADD COLUMN IF NOT EXISTS banner_file character varying(255) DEFAULT NULL;

ALTER TABLE user_options
    ADD COLUMN IF NOT EXISTS banner_position character varying(50) DEFAULT 'center';

ALTER TABLE user_options
    ADD COLUMN IF NOT EXISTS banner_size character varying(50) DEFAULT 'cover';

COMMENT ON COLUMN public.user_options.banner_file IS 'Custom uploaded banner image filename, stored in public/a/ (same dir as avatars)';
COMMENT ON COLUMN public.user_options.banner_position IS 'CSS background-position for the banner';
COMMENT ON COLUMN public.user_options.banner_size IS 'CSS background-size for the banner (e.g. cover, contain, or a percentage)';
