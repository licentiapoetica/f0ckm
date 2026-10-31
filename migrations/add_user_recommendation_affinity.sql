-- User Interest & Behavior Recommendation Affinity Tables

CREATE TABLE IF NOT EXISTS public.user_tag_affinity (
    user_id integer NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    tag_id integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    score real DEFAULT 0.0,
    interaction_count integer DEFAULT 1,
    last_interacted timestamp with time zone DEFAULT now(),
    PRIMARY KEY (user_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_user_tag_affinity_user_score 
ON public.user_tag_affinity(user_id, score DESC);

CREATE TABLE IF NOT EXISTS public.user_creator_affinity (
    user_id integer NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    creator_username text NOT NULL,
    score real DEFAULT 0.0,
    interaction_count integer DEFAULT 1,
    last_interacted timestamp with time zone DEFAULT now(),
    PRIMARY KEY (user_id, creator_username)
);

CREATE INDEX IF NOT EXISTS idx_user_creator_affinity_user_score 
ON public.user_creator_affinity(user_id, score DESC);
