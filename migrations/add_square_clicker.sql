-- Square Clicker: user-made beatmaps for audio and video items and their scores.
-- notes: JSON array of { t: ms from song start, x: 0..1, y: 0..1 (viewport fractions), d: hold ms (0 = tap),
--   p: optional slider path [[dt ms, x, y], ...] recorded while the hold was dragged }

CREATE TABLE IF NOT EXISTS public.sqc_maps (
    id serial PRIMARY KEY,
    item_id integer NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    album_item_id integer REFERENCES album_items(id) ON DELETE CASCADE,
    user_id integer REFERENCES "user"(id) ON DELETE SET NULL,
    title text NOT NULL DEFAULT 'Untitled',
    notes jsonb NOT NULL DEFAULT '[]'::jsonb,
    note_count integer NOT NULL DEFAULT 0,
    duration_ms integer NOT NULL DEFAULT 0,
    plays integer NOT NULL DEFAULT 0,
    created_at integer NOT NULL DEFAULT 0
);

-- album_item_id: set for maps of one entry of an album (each entry is its own track)
ALTER TABLE public.sqc_maps ADD COLUMN IF NOT EXISTS album_item_id integer REFERENCES album_items(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_sqc_maps_item ON public.sqc_maps(item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.sqc_scores (
    id serial PRIMARY KEY,
    map_id integer NOT NULL REFERENCES sqc_maps(id) ON DELETE CASCADE,
    user_id integer REFERENCES "user"(id) ON DELETE CASCADE,
    score integer NOT NULL DEFAULT 0,
    accuracy real NOT NULL DEFAULT 0,
    max_combo integer NOT NULL DEFAULT 0,
    hits jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sqc_scores_map ON public.sqc_scores(map_id, score DESC);
