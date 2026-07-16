-- User emoji favorites — persisted per-user, cross-device
CREATE TABLE IF NOT EXISTS user_emoji_favorites (
    user_id   integer  NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    emoji_name text    NOT NULL,
    emoji_url  text    NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, emoji_name)
);

CREATE INDEX IF NOT EXISTS idx_user_emoji_favorites_user_id ON user_emoji_favorites (user_id);
