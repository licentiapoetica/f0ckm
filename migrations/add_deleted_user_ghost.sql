-- Migration: deleted_user ghost account
-- Deleted users' comments, tags, halls, reports, etc. are reassigned to this system account
-- (see /api/v2/admin/users/delete, which also creates it on first use).
-- It can never log in: password '!' matches no hash, it is not activated and it is banned.

INSERT INTO public."user" (login, "user", password, admin, is_moderator, activated, banned, ban_reason, created_at)
VALUES ('deleted_user', 'deleted_user', '!', false, false, false, true, 'System account', now())
ON CONFLICT (login) DO NOTHING;

INSERT INTO public.user_options (user_id, mode, theme, fullscreen, avatar, avatar_file, display_name)
SELECT id, 0, 'amoled', 0, NULL, 'default.png', 'deleted user'
FROM public."user" WHERE login = 'deleted_user'
ON CONFLICT (user_id) DO NOTHING;
