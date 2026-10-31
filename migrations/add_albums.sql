-- Migration: Add Album Support
-- Allows posts to contain multiple pictures displayed as an album gallery

ALTER TABLE public.items ADD COLUMN IF NOT EXISTS is_album boolean DEFAULT false;
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS album_count integer DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.album_items (
    id SERIAL PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
    dest CHARACTER VARYING(60) NOT NULL,
    mime CHARACTER VARYING(100) NOT NULL,
    size INTEGER NOT NULL,
    checksum CHARACTER VARYING(255) NOT NULL,
    phash TEXT,
    width INTEGER,
    height INTEGER,
    order_index INTEGER NOT NULL DEFAULT 0,
    slug CHARACTER VARYING(60) DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_album_items_item_id ON public.album_items(item_id, order_index ASC);
CREATE INDEX IF NOT EXISTS idx_album_items_slug ON public.album_items(slug);

CREATE TABLE IF NOT EXISTS public.album_items_tags_assign (
    album_item_id INTEGER NOT NULL REFERENCES public.album_items(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES public."user"(id) ON DELETE SET DEFAULT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (album_item_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_album_items_tags_assign_tag_id ON public.album_items_tags_assign(tag_id);
CREATE INDEX IF NOT EXISTS idx_album_items_tags_assign_album_item_id ON public.album_items_tags_assign(album_item_id);
