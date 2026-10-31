-- Add visibility and slug columns to items table
ALTER TABLE items ADD COLUMN IF NOT EXISTS visibility smallint DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS slug varchar(16) UNIQUE;
ALTER TABLE user_options ADD COLUMN IF NOT EXISTS default_upload_visibility smallint DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_slug ON items(slug);

COMMENT ON COLUMN items.visibility IS '0=public, 1=unlisted, 2=private';
COMMENT ON COLUMN items.slug IS 'Unique unguessable 11-character URL slug for direct access';
COMMENT ON COLUMN user_options.default_upload_visibility IS 'Default upload visibility preference for user (0=public, 1=unlisted, 2=private)';

-- Populate missing slugs for existing items
DO $$
DECLARE
    r RECORD;
    chars text := 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
    new_slug text;
    i integer;
BEGIN
    FOR r IN SELECT id FROM items WHERE slug IS NULL LOOP
        LOOP
            new_slug := '';
            FOR i IN 1..11 LOOP
                new_slug := new_slug || substr(chars, floor(random() * 64 + 1)::integer, 1);
            END LOOP;
            BEGIN
                UPDATE items SET slug = new_slug WHERE id = r.id;
                EXIT;
            EXCEPTION WHEN unique_violation THEN
            END;
        END LOOP;
    END LOOP;
END $$;

-- Fix any items with NULL visibility (should default to 0 = public)
UPDATE items SET visibility = 0 WHERE visibility IS NULL;
ALTER TABLE items ALTER COLUMN visibility SET NOT NULL;
ALTER TABLE items ALTER COLUMN visibility SET DEFAULT 0;
