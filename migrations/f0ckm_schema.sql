--
-- PostgreSQL database dump
--

\restrict RMNKNzVQLV2ZcwmM3bmhglTot5nRoju9FmRyi3eUMfNy6iJUBfHRIgXnbrpJikG

-- Dumped from database version 17.9 (Debian 17.9-1.pgdg13+1)
-- Dumped by pg_dump version 17.9 (Debian 17.9-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

DROP PUBLICATION IF EXISTS alltables;
ALTER TABLE IF EXISTS ONLY public.user_api_keys DROP CONSTRAINT IF EXISTS user_api_keys_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_api_keys DROP CONSTRAINT IF EXISTS user_api_keys_api_key_key;
ALTER TABLE IF EXISTS ONLY public.user_api_keys DROP CONSTRAINT IF EXISTS user_api_keys_pkey;
ALTER TABLE IF EXISTS ONLY public.user_warnings DROP CONSTRAINT IF EXISTS user_warnings_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_warnings DROP CONSTRAINT IF EXISTS user_warnings_admin_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_video_views DROP CONSTRAINT IF EXISTS user_video_views_video_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_video_views DROP CONSTRAINT IF EXISTS user_video_views_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_sessions DROP CONSTRAINT IF EXISTS user_sessions_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_pubkeys DROP CONSTRAINT IF EXISTS user_pubkeys_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_options DROP CONSTRAINT IF EXISTS user_options_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_options DROP CONSTRAINT IF EXISTS user_options_avatar_fkey;
ALTER TABLE IF EXISTS ONLY public.user_halls DROP CONSTRAINT IF EXISTS user_halls_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_halls_assign DROP CONSTRAINT IF EXISTS user_halls_assign_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_halls_assign DROP CONSTRAINT IF EXISTS user_halls_assign_item_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_halls_assign DROP CONSTRAINT IF EXISTS user_halls_assign_hall_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_dm_keyvault DROP CONSTRAINT IF EXISTS user_dm_keyvault_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_conversation_states DROP CONSTRAINT IF EXISTS user_conversation_states_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.user_conversation_states DROP CONSTRAINT IF EXISTS user_conversation_states_other_id_fkey;
ALTER TABLE IF EXISTS ONLY public.tags_assign DROP CONSTRAINT IF EXISTS tags_assign_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.tags_assign DROP CONSTRAINT IF EXISTS tags_assign_tag_id_fkey;
ALTER TABLE IF EXISTS ONLY public.tags_assign DROP CONSTRAINT IF EXISTS tags_assign_item_id_fkey;
ALTER TABLE IF EXISTS ONLY public.tags_alias DROP CONSTRAINT IF EXISTS tags_alias_tag_orig_id_fkey;
ALTER TABLE IF EXISTS ONLY public.reports DROP CONSTRAINT IF EXISTS reports_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.reports DROP CONSTRAINT IF EXISTS reports_resolved_by_fkey;
ALTER TABLE IF EXISTS ONLY public.reports DROP CONSTRAINT IF EXISTS reports_reporter_id_fkey;
ALTER TABLE IF EXISTS ONLY public.reports DROP CONSTRAINT IF EXISTS reports_item_id_fkey;
ALTER TABLE IF EXISTS ONLY public.reports DROP CONSTRAINT IF EXISTS reports_comment_id_fkey;
ALTER TABLE IF EXISTS ONLY public.private_messages DROP CONSTRAINT IF EXISTS private_messages_sender_id_fkey;
ALTER TABLE IF EXISTS ONLY public.private_messages DROP CONSTRAINT IF EXISTS private_messages_recipient_id_fkey;
ALTER TABLE IF EXISTS ONLY public.notifications DROP CONSTRAINT IF EXISTS notifications_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.notifications DROP CONSTRAINT IF EXISTS notifications_item_id_fkey;
ALTER TABLE IF EXISTS ONLY public.link_token DROP CONSTRAINT IF EXISTS link_token_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.invite_tokens DROP CONSTRAINT IF EXISTS invite_tokens_used_by_fkey;
ALTER TABLE IF EXISTS ONLY public.invite_tokens DROP CONSTRAINT IF EXISTS invite_tokens_created_by_fkey;
ALTER TABLE IF EXISTS ONLY public.halls_assign DROP CONSTRAINT IF EXISTS halls_assign_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.halls_assign DROP CONSTRAINT IF EXISTS halls_assign_item_id_fkey;
ALTER TABLE IF EXISTS ONLY public.halls_assign DROP CONSTRAINT IF EXISTS halls_assign_hall_id_fkey;
ALTER TABLE IF EXISTS ONLY public.global_chat DROP CONSTRAINT IF EXISTS global_chat_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.favorites DROP CONSTRAINT IF EXISTS favorites_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.favorites DROP CONSTRAINT IF EXISTS favorites_item_id_fkey;
ALTER TABLE IF EXISTS ONLY public.discord_queue DROP CONSTRAINT IF EXISTS discord_queue_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.discord_queue DROP CONSTRAINT IF EXISTS discord_queue_item_id_fkey;
ALTER TABLE IF EXISTS ONLY public.comments DROP CONSTRAINT IF EXISTS comments_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.comments DROP CONSTRAINT IF EXISTS comments_parent_id_fkey;
ALTER TABLE IF EXISTS ONLY public.comments DROP CONSTRAINT IF EXISTS comments_item_id_fkey;
ALTER TABLE IF EXISTS ONLY public.comment_subscriptions DROP CONSTRAINT IF EXISTS comment_subscriptions_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.comment_subscriptions DROP CONSTRAINT IF EXISTS comment_subscriptions_item_id_fkey;
DROP TRIGGER IF EXISTS trigger_notify_private_message ON public.private_messages;
DROP TRIGGER IF EXISTS trigger_notify_notification ON public.notifications;
DROP TRIGGER IF EXISTS trigger_notify_activity ON public.comments;
DROP TRIGGER IF EXISTS trg_comments_xd_score ON public.comments;
DROP TRIGGER IF EXISTS tags_bu ON public.tags;
DROP TRIGGER IF EXISTS tags_bi ON public.tags;
DROP TRIGGER IF EXISTS tags_assign_ad ON public.tags_assign;
DROP TRIGGER IF EXISTS global_chat_notify ON public.global_chat;
CREATE OR REPLACE VIEW public.items_li AS
SELECT
    NULL::integer AS id,
    NULL::character varying(255) AS src,
    NULL::character varying(40) AS dest,
    NULL::character varying(100) AS mime,
    NULL::integer AS size,
    NULL::character varying(255) AS checksum,
    NULL::character varying(40) AS username,
    NULL::character varying(255) AS userchannel,
    NULL::character varying(40) AS usernetwork,
    NULL::integer AS stamp;
DROP INDEX IF EXISTS public.tags_assign_tag_id_idx;
DROP INDEX IF EXISTS public.items_phash;
DROP INDEX IF EXISTS public.idx_user_warnings_user_status;
DROP INDEX IF EXISTS public.idx_user_last_seen;
DROP INDEX IF EXISTS public.idx_user_halls_user_id;
DROP INDEX IF EXISTS public.idx_user_halls_assign_item;
DROP INDEX IF EXISTS public.idx_user_halls_assign_hall;
DROP INDEX IF EXISTS public.idx_user_api_keys_api_key;
DROP INDEX IF EXISTS public.idx_user_alias_userid;
DROP INDEX IF EXISTS public.idx_user_alias_type;
DROP INDEX IF EXISTS public.idx_user_alias_alias;
DROP INDEX IF EXISTS public.idx_ucs_user_hidden;
DROP INDEX IF EXISTS public.idx_reports_status;
DROP INDEX IF EXISTS public.idx_pm_sender;
DROP INDEX IF EXISTS public.idx_pm_recipient;
DROP INDEX IF EXISTS public.idx_pm_conversation;
DROP INDEX IF EXISTS public.idx_notifications_user_id;
DROP INDEX IF EXISTS public.idx_notifications_unread;
DROP INDEX IF EXISTS public.idx_login_attempts_username_time;
DROP INDEX IF EXISTS public.idx_login_attempts_ip_time;
DROP INDEX IF EXISTS public.idx_link_token_token;
DROP INDEX IF EXISTS public.idx_items_xd_score;
DROP INDEX IF EXISTS public.idx_items_username_lower;
DROP INDEX IF EXISTS public.idx_items_username;
DROP INDEX IF EXISTS public.idx_items_pinned_id;
DROP INDEX IF EXISTS public.idx_items_is_purged;
DROP INDEX IF EXISTS public.idx_items_is_deleted;
DROP INDEX IF EXISTS public.idx_items_active_id;
DROP INDEX IF EXISTS public.idx_global_chat_created_at;
DROP INDEX IF EXISTS public.idx_discord_queue_sent;
DROP INDEX IF EXISTS public.idx_comments_user_id;
DROP INDEX IF EXISTS public.idx_comments_item_id;
DROP INDEX IF EXISTS public.idx_comments_is_pinned;
DROP INDEX IF EXISTS public.idx_audit_log_user_id;
DROP INDEX IF EXISTS public.idx_audit_log_created_at;
DROP INDEX IF EXISTS public.idx_audit_log_action;
ALTER TABLE IF EXISTS ONLY public.user_warnings DROP CONSTRAINT IF EXISTS user_warnings_pkey;
ALTER TABLE IF EXISTS ONLY public.user_video_views DROP CONSTRAINT IF EXISTS user_video_views_pkey;
ALTER TABLE IF EXISTS ONLY public.user_pubkeys DROP CONSTRAINT IF EXISTS user_pubkeys_pkey;
ALTER TABLE IF EXISTS ONLY public.user_options DROP CONSTRAINT IF EXISTS user_options_user_id;
ALTER TABLE IF EXISTS ONLY public."user" DROP CONSTRAINT IF EXISTS user_name_unique;
ALTER TABLE IF EXISTS ONLY public."user" DROP CONSTRAINT IF EXISTS user_login_unique;
ALTER TABLE IF EXISTS ONLY public.user_halls DROP CONSTRAINT IF EXISTS user_halls_user_id_slug_key;
ALTER TABLE IF EXISTS ONLY public.user_halls DROP CONSTRAINT IF EXISTS user_halls_pkey;
ALTER TABLE IF EXISTS ONLY public.user_halls_assign DROP CONSTRAINT IF EXISTS user_halls_assign_pkey;
ALTER TABLE IF EXISTS ONLY public.user_dm_keyvault DROP CONSTRAINT IF EXISTS user_dm_keyvault_pkey;
ALTER TABLE IF EXISTS ONLY public.user_conversation_states DROP CONSTRAINT IF EXISTS user_conversation_states_pkey;
ALTER TABLE IF EXISTS ONLY public.tags DROP CONSTRAINT IF EXISTS tags_id;
ALTER TABLE IF EXISTS ONLY public.tags_assign DROP CONSTRAINT IF EXISTS tags_assign_item_id_tag_id_unique;
ALTER TABLE IF EXISTS ONLY public.tags_assign DROP CONSTRAINT IF EXISTS tags_assign_item_id_tag_id_primary;
ALTER TABLE IF EXISTS ONLY public.tags_alias DROP CONSTRAINT IF EXISTS tags_alias_tag_orig_id;
ALTER TABLE IF EXISTS ONLY public.tags_alias DROP CONSTRAINT IF EXISTS tags_alias_tag_alias_tag_orig_id;
ALTER TABLE IF EXISTS ONLY public.site_settings DROP CONSTRAINT IF EXISTS site_settings_pkey;
ALTER TABLE IF EXISTS ONLY public.reports DROP CONSTRAINT IF EXISTS reports_pkey;
ALTER TABLE IF EXISTS ONLY public.private_messages DROP CONSTRAINT IF EXISTS private_messages_pkey;
ALTER TABLE IF EXISTS ONLY public.notifications DROP CONSTRAINT IF EXISTS notifications_pkey;
ALTER TABLE IF EXISTS ONLY public.meta_cache DROP CONSTRAINT IF EXISTS meta_cache_pkey;
ALTER TABLE IF EXISTS ONLY public.meme_templates DROP CONSTRAINT IF EXISTS meme_templates_template_id_key;
ALTER TABLE IF EXISTS ONLY public.meme_templates DROP CONSTRAINT IF EXISTS meme_templates_pkey;
ALTER TABLE IF EXISTS ONLY public.login_attempts DROP CONSTRAINT IF EXISTS login_attempts_pkey;
ALTER TABLE IF EXISTS ONLY public.link_token DROP CONSTRAINT IF EXISTS link_token_token_key;
ALTER TABLE IF EXISTS ONLY public.link_token DROP CONSTRAINT IF EXISTS link_token_pkey;
ALTER TABLE IF EXISTS ONLY public.items DROP CONSTRAINT IF EXISTS items_checksum;
ALTER TABLE IF EXISTS ONLY public.invite_tokens DROP CONSTRAINT IF EXISTS invite_tokens_token_key;
ALTER TABLE IF EXISTS ONLY public.invite_tokens DROP CONSTRAINT IF EXISTS invite_tokens_pkey;
ALTER TABLE IF EXISTS ONLY public.user_sessions DROP CONSTRAINT IF EXISTS idx_16572_primary;
ALTER TABLE IF EXISTS ONLY public.user_options DROP CONSTRAINT IF EXISTS idx_16567_user_id;
ALTER TABLE IF EXISTS ONLY public."user" DROP CONSTRAINT IF EXISTS idx_16554_primary;
ALTER TABLE IF EXISTS ONLY public.items DROP CONSTRAINT IF EXISTS idx_16526_primary;
ALTER TABLE IF EXISTS ONLY public.favorites DROP CONSTRAINT IF EXISTS idx_16521_primary;
ALTER TABLE IF EXISTS ONLY public.halls DROP CONSTRAINT IF EXISTS halls_slug_key;
ALTER TABLE IF EXISTS ONLY public.halls DROP CONSTRAINT IF EXISTS halls_pkey;
ALTER TABLE IF EXISTS ONLY public.halls_assign DROP CONSTRAINT IF EXISTS halls_assign_pkey;
ALTER TABLE IF EXISTS ONLY public.global_chat_settings DROP CONSTRAINT IF EXISTS global_chat_settings_pkey;
ALTER TABLE IF EXISTS ONLY public.global_chat DROP CONSTRAINT IF EXISTS global_chat_pkey;
ALTER TABLE IF EXISTS ONLY public.discord_queue DROP CONSTRAINT IF EXISTS discord_queue_pkey;
ALTER TABLE IF EXISTS ONLY public.custom_emojis DROP CONSTRAINT IF EXISTS custom_emojis_pkey;
ALTER TABLE IF EXISTS ONLY public.custom_emojis DROP CONSTRAINT IF EXISTS custom_emojis_name_key;
ALTER TABLE IF EXISTS ONLY public.comments DROP CONSTRAINT IF EXISTS comments_pkey;
ALTER TABLE IF EXISTS ONLY public.comment_subscriptions DROP CONSTRAINT IF EXISTS comment_subscriptions_pkey;
ALTER TABLE IF EXISTS ONLY public.audit_log DROP CONSTRAINT IF EXISTS audit_log_pkey;
ALTER TABLE IF EXISTS public.user_warnings ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.user_halls ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.reports ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.private_messages ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.notifications ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.meme_templates ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.login_attempts ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.link_token ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.invite_tokens ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.halls ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.global_chat ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.discord_queue ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.custom_emojis ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.comments ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.audit_log ALTER COLUMN id DROP DEFAULT;
DROP SEQUENCE IF EXISTS public.user_warnings_id_seq;
DROP TABLE IF EXISTS public.user_warnings;
DROP TABLE IF EXISTS public.user_video_views;
DROP TABLE IF EXISTS public.user_sessions;
DROP SEQUENCE IF EXISTS public.user_sessions_id_seq;
DROP TABLE IF EXISTS public.user_pubkeys;
DROP TABLE IF EXISTS public.user_options;
DROP SEQUENCE IF EXISTS public.user_halls_id_seq;
DROP TABLE IF EXISTS public.user_halls_assign;
DROP TABLE IF EXISTS public.user_halls;
DROP TABLE IF EXISTS public.user_dm_keyvault;
DROP TABLE IF EXISTS public.user_conversation_states;
DROP TABLE IF EXISTS public.user_api_keys;
DROP TABLE IF EXISTS public.user_alias;
DROP TABLE IF EXISTS public."user";
DROP SEQUENCE IF EXISTS public.user_id_seq;
DROP TABLE IF EXISTS public.tags_alias;
DROP TABLE IF EXISTS public.tags;
DROP SEQUENCE IF EXISTS public.tags_id_seq;
DROP TABLE IF EXISTS public.site_settings;
DROP SEQUENCE IF EXISTS public.reports_id_seq;
DROP TABLE IF EXISTS public.reports;
DROP SEQUENCE IF EXISTS public.private_messages_id_seq;
DROP TABLE IF EXISTS public.private_messages;
DROP SEQUENCE IF EXISTS public.notifications_id_seq;
DROP TABLE IF EXISTS public.notifications;
DROP TABLE IF EXISTS public.meta_cache;
DROP SEQUENCE IF EXISTS public.meme_templates_id_seq;
DROP TABLE IF EXISTS public.meme_templates;
DROP SEQUENCE IF EXISTS public.login_attempts_id_seq;
DROP TABLE IF EXISTS public.login_attempts;
DROP SEQUENCE IF EXISTS public.link_token_id_seq;
DROP TABLE IF EXISTS public.link_token;
DROP VIEW IF EXISTS public.items_sfw;
DROP TABLE IF EXISTS public.tags_nsfp;
DROP TABLE IF EXISTS public.tags_assign;
DROP VIEW IF EXISTS public.items_li;
DROP TABLE IF EXISTS public.items;
DROP SEQUENCE IF EXISTS public.items_id_seq;
DROP SEQUENCE IF EXISTS public.invite_tokens_id_seq;
DROP TABLE IF EXISTS public.invite_tokens;
DROP SEQUENCE IF EXISTS public.halls_id_seq;
DROP TABLE IF EXISTS public.halls_assign;
DROP TABLE IF EXISTS public.halls;
DROP TABLE IF EXISTS public.global_chat_settings;
DROP SEQUENCE IF EXISTS public.global_chat_id_seq;
DROP TABLE IF EXISTS public.global_chat;
DROP TABLE IF EXISTS public.favorites;
DROP SEQUENCE IF EXISTS public.discord_queue_id_seq;
DROP TABLE IF EXISTS public.discord_queue;
DROP SEQUENCE IF EXISTS public.custom_emojis_id_seq;
DROP TABLE IF EXISTS public.custom_emojis;
DROP SEQUENCE IF EXISTS public.comments_id_seq;
DROP TABLE IF EXISTS public.comments;
DROP TABLE IF EXISTS public.comment_subscriptions;
DROP SEQUENCE IF EXISTS public.audit_log_id_seq;
DROP TABLE IF EXISTS public.audit_log;
DROP FUNCTION IF EXISTS public.update_item_xd_score(p_item_id bigint);
DROP FUNCTION IF EXISTS public.unaccent_text(text);
DROP FUNCTION IF EXISTS public.trg_update_xd_score();
DROP FUNCTION IF EXISTS public.slugify(v text);
DROP FUNCTION IF EXISTS public.notify_private_message();
DROP FUNCTION IF EXISTS public.notify_notification();
DROP FUNCTION IF EXISTS public.notify_global_chat();
DROP FUNCTION IF EXISTS public.notify_activity();
DROP FUNCTION IF EXISTS public.fill_normalized();
DROP FUNCTION IF EXISTS public.delete_unused_tags();
DROP EXTENSION IF EXISTS unaccent;
-- *not* dropping schema, since initdb creates it
--
-- Name: public; Type: SCHEMA; Schema: -; Owner: f0ckm
--

-- *not* creating schema, since initdb creates it


ALTER SCHEMA public OWNER TO f0ckm;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: f0ckm
--

COMMENT ON SCHEMA public IS '';


--
-- Name: unaccent; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;


--
-- Name: EXTENSION unaccent; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION unaccent IS 'text search dictionary that removes accents';


--
-- Name: delete_unused_tags(); Type: FUNCTION; Schema: public; Owner: f0ckm
--

CREATE FUNCTION public.delete_unused_tags() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  delete from tags
  where
    tags.id not in (select tag_id from tags_assign) and
    tags.id = OLD.tag_id and
    tags.tag != 'sfw' and
    tags.tag != 'nsfw';
  return OLD;
end $$;


ALTER FUNCTION public.delete_unused_tags() OWNER TO f0ckm;

--
-- Name: fill_normalized(); Type: FUNCTION; Schema: public; Owner: f0ckm
--

CREATE FUNCTION public.fill_normalized() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  NEW.normalized = slugify(NEW.tag);
  return NEW;
end$$;


ALTER FUNCTION public.fill_normalized() OWNER TO f0ckm;

--
-- Name: notify_activity(); Type: FUNCTION; Schema: public; Owner: f0ckm
--

CREATE FUNCTION public.notify_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
 DECLARE
     payload JSON;
 BEGIN
     SELECT json_build_object(
         'id', NEW.id,
         'user_id', NEW.user_id,
         'item_id', NEW.item_id,
         'parent_id', NEW.parent_id,
         'body', LEFT(NEW.content, 2000), -- Truncate to prevent payload string too long error
         'created_at', NEW.created_at
     ) INTO payload;
     
     PERFORM pg_notify('activity', payload::text);
     RETURN NEW;
 END;
 $$;


ALTER FUNCTION public.notify_activity() OWNER TO f0ckm;

--
-- Name: notify_global_chat(); Type: FUNCTION; Schema: public; Owner: f0ckm
--

CREATE FUNCTION public.notify_global_chat() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('global_chat', row_to_json(NEW)::text);
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.notify_global_chat() OWNER TO f0ckm;

--
-- Name: notify_notification(); Type: FUNCTION; Schema: public; Owner: f0ckm
--

CREATE FUNCTION public.notify_notification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    payload JSON;
BEGIN
    -- Only notify on INSERT or when a notification transitions to is_read = true
    IF (TG_OP = 'INSERT') OR (TG_OP = 'UPDATE' AND OLD.is_read = false AND NEW.is_read = true) THEN
        SELECT json_build_object(
            'id', NEW.id,
            'user_id', NEW.user_id,
            'type', NEW.type,
            'item_id', NEW.item_id,
            'is_read', NEW.is_read,
            'created_at', NEW.created_at
        ) INTO payload;
        
        PERFORM pg_notify('notifications', payload::text);
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.notify_notification() OWNER TO f0ckm;

--
-- Name: notify_private_message(); Type: FUNCTION; Schema: public; Owner: f0ckm
--

CREATE FUNCTION public.notify_private_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('private_message', json_build_object(
        'id',           NEW.id,
        'sender_id',    NEW.sender_id,
        'recipient_id', NEW.recipient_id,
        'created_at',   NEW.created_at
    )::text);
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.notify_private_message() OWNER TO f0ckm;

--
-- Name: slugify(text); Type: FUNCTION; Schema: public; Owner: f0ckm
--

CREATE FUNCTION public.slugify(v text) RETURNS text
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN trim(BOTH '-' FROM regexp_replace(lower(unaccent(trim(v))), '[\u0000-\u002f \u003a-\u0040\u005b-\u0060\u007b-\u00bf]+', '', 'gi'));
END;
$$;


ALTER FUNCTION public.slugify(v text) OWNER TO f0ckm;

--
-- Name: trg_update_xd_score(); Type: FUNCTION; Schema: public; Owner: f0ckm
--

CREATE FUNCTION public.trg_update_xd_score() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM update_item_xd_score(OLD.item_id);
    ELSE
        PERFORM update_item_xd_score(NEW.item_id);
    END IF;
    RETURN NULL;
END;
$$;


ALTER FUNCTION public.trg_update_xd_score() OWNER TO f0ckm;

--
-- Name: unaccent_text(text); Type: FUNCTION; Schema: public; Owner: f0ckm
--

CREATE FUNCTION public.unaccent_text(text) RETURNS text
    LANGUAGE sql IMMUTABLE COST 1
    AS $_$
  -- unaccent is STABLE, but the indexes must use IMMUTABLE functions.
  -- comment this line out when calling pg_dump.
  SELECT unaccent($1);

  -- Uncomment this line when calling pg_dump.
  --SELECT ''::text;
$_$;


ALTER FUNCTION public.unaccent_text(text) OWNER TO f0ckm;

--
-- Name: update_item_xd_score(bigint); Type: FUNCTION; Schema: public; Owner: f0ckm
--

CREATE FUNCTION public.update_item_xd_score(p_item_id bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.items SET xd_score = (
        SELECT COALESCE(SUM(length(m[1])), 0)
        FROM public.comments c
        CROSS JOIN LATERAL regexp_matches(c.content, 'x(D+)', 'gi') AS m
        WHERE c.item_id = p_item_id AND c.is_deleted = false
    )
    WHERE id = p_item_id;
END;
$$;


ALTER FUNCTION public.update_item_xd_score(p_item_id bigint) OWNER TO f0ckm;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.audit_log (
    id integer NOT NULL,
    user_id integer NOT NULL,
    action character varying(50) NOT NULL,
    target_type character varying(50),
    target_id character varying(50),
    details jsonb,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.audit_log OWNER TO f0ckm;

--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.audit_log_id_seq OWNER TO f0ckm;

--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: comment_subscriptions; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.comment_subscriptions (
    user_id integer NOT NULL,
    item_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    is_subscribed boolean DEFAULT true
);


ALTER TABLE public.comment_subscriptions OWNER TO f0ckm;

--
-- Name: comments; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.comments (
    id integer NOT NULL,
    item_id integer NOT NULL,
    user_id integer NOT NULL,
    parent_id integer,
    content text NOT NULL,
    is_deleted boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone,
    vote_score integer DEFAULT 0,
    is_pinned boolean DEFAULT false,
    video_time numeric(10,3)
);


ALTER TABLE public.comments OWNER TO f0ckm;

--
-- Name: comments_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.comments_id_seq OWNER TO f0ckm;

--
-- Name: comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.comments_id_seq OWNED BY public.comments.id;


--
-- Name: comment_files; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.comment_files (
    id integer NOT NULL,
    comment_id integer,
    user_id integer NOT NULL,
    dest character varying(40) NOT NULL,
    mime character varying(100) NOT NULL,
    size integer NOT NULL,
    checksum character varying(255) NOT NULL,
    phash text,
    original_filename text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.comment_files OWNER TO f0ckm;

--
-- Name: comment_files_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.comment_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.comment_files_id_seq OWNER TO f0ckm;

--
-- Name: comment_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.comment_files_id_seq OWNED BY public.comment_files.id;


--
-- Name: custom_emojis; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.custom_emojis (
    id integer NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.custom_emojis OWNER TO f0ckm;

--
-- Name: custom_emojis_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.custom_emojis_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.custom_emojis_id_seq OWNER TO f0ckm;

--
-- Name: custom_emojis_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.custom_emojis_id_seq OWNED BY public.custom_emojis.id;


--
-- Name: discord_queue; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.discord_queue (
    id integer NOT NULL,
    user_id integer NOT NULL,
    item_id integer NOT NULL,
    type character varying(50) DEFAULT 'approve'::character varying NOT NULL,
    sent boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.discord_queue OWNER TO f0ckm;

--
-- Name: discord_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.discord_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.discord_queue_id_seq OWNER TO f0ckm;

--
-- Name: discord_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.discord_queue_id_seq OWNED BY public.discord_queue.id;


--
-- Name: favorites; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.favorites (
    user_id integer NOT NULL,
    item_id integer NOT NULL
);


ALTER TABLE public.favorites OWNER TO f0ckm;

--
-- Name: global_chat; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.global_chat (
    id bigint NOT NULL,
    user_id integer NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.global_chat OWNER TO f0ckm;

--
-- Name: global_chat_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.global_chat_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.global_chat_id_seq OWNER TO f0ckm;

--
-- Name: global_chat_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.global_chat_id_seq OWNED BY public.global_chat.id;


--
-- Name: global_chat_settings; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.global_chat_settings (
    key text NOT NULL,
    value text
);


ALTER TABLE public.global_chat_settings OWNER TO f0ckm;

--
-- Name: halls; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.halls (
    id integer NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    custom_image text,
    description text DEFAULT ''::text NOT NULL,
    rating text DEFAULT 'sfw'::text NOT NULL
);


ALTER TABLE public.halls OWNER TO f0ckm;

--
-- Name: halls_assign; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.halls_assign (
    hall_id integer NOT NULL,
    item_id integer NOT NULL,
    user_id integer,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.halls_assign OWNER TO f0ckm;

--
-- Name: halls_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.halls_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.halls_id_seq OWNER TO f0ckm;

--
-- Name: halls_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.halls_id_seq OWNED BY public.halls.id;


--
-- Name: invite_tokens; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.invite_tokens (
    id integer NOT NULL,
    token character varying(32) NOT NULL,
    created_at bigint NOT NULL,
    created_by integer,
    used_by integer,
    is_used boolean DEFAULT false,
    created_by_discord character varying(255) DEFAULT NULL::character varying,
    created_by_matrix character varying(255) DEFAULT NULL::character varying
);


ALTER TABLE public.invite_tokens OWNER TO f0ckm;

--
-- Name: invite_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.invite_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.invite_tokens_id_seq OWNER TO f0ckm;

--
-- Name: invite_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.invite_tokens_id_seq OWNED BY public.invite_tokens.id;


--
-- Name: items_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.items_id_seq OWNER TO f0ckm;

--
-- Name: items; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.items (
    id integer DEFAULT nextval('public.items_id_seq'::regclass) NOT NULL,
    src character varying(255) NOT NULL,
    dest character varying(40) NOT NULL,
    mime character varying(100) NOT NULL,
    size integer NOT NULL,
    checksum character varying(255) NOT NULL,
    username character varying(40) NOT NULL,
    userchannel character varying(255) NOT NULL,
    usernetwork character varying(40) NOT NULL,
    stamp integer NOT NULL,
    active boolean NOT NULL,
    thumb character varying(100),
    is_deleted boolean DEFAULT false,
    is_comments_locked boolean DEFAULT false,
    phash text,
    is_purged boolean DEFAULT false,
    has_coverart boolean DEFAULT false,
    is_pinned boolean DEFAULT false,
    is_oc boolean DEFAULT false,
    xd_score integer DEFAULT 0 NOT NULL,
    original_filename text
);


ALTER TABLE public.items OWNER TO f0ckm;

--
-- Name: COLUMN items.src; Type: COMMENT; Schema: public; Owner: f0ckm
--

COMMENT ON COLUMN public.items.src IS 'src-Link';


--
-- Name: COLUMN items.dest; Type: COMMENT; Schema: public; Owner: f0ckm
--

COMMENT ON COLUMN public.items.dest IS 'filename';


--
-- Name: items_li; Type: VIEW; Schema: public; Owner: f0ckm
--

CREATE VIEW public.items_li AS
SELECT
    NULL::integer AS id,
    NULL::character varying(255) AS src,
    NULL::character varying(40) AS dest,
    NULL::character varying(100) AS mime,
    NULL::integer AS size,
    NULL::character varying(255) AS checksum,
    NULL::character varying(40) AS username,
    NULL::character varying(255) AS userchannel,
    NULL::character varying(40) AS usernetwork,
    NULL::integer AS stamp;


ALTER VIEW public.items_li OWNER TO f0ckm;

--
-- Name: tags_assign; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.tags_assign (
    item_id integer NOT NULL,
    tag_id integer NOT NULL,
    user_id integer DEFAULT 10 NOT NULL
);


ALTER TABLE public.tags_assign OWNER TO f0ckm;

--
-- Name: tags_nsfp; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.tags_nsfp (
    id integer NOT NULL
);


ALTER TABLE public.tags_nsfp OWNER TO f0ckm;

--
-- Name: items_sfw; Type: VIEW; Schema: public; Owner: f0ckm
--

CREATE VIEW public.items_sfw AS
 SELECT ( SELECT
                CASE
                    WHEN (tags_assign.tag_id > 0) THEN tags_assign.tag_id
                    ELSE 0
                END AS "case"
           FROM public.tags_assign
          WHERE ((tags_assign.tag_id = ANY (ARRAY[1, 2])) AND (tags_assign.item_id = items.id))) AS sfw,
    ( SELECT
                CASE
                    WHEN (tags_assign.tag_id > 0) THEN 1
                    ELSE 0
                END AS "case"
           FROM public.tags_assign
          WHERE ((tags_assign.tag_id IN ( SELECT tags_nsfp.id
                   FROM public.tags_nsfp)) AND (tags_assign.item_id = items.id))
         LIMIT 1) AS nsfp,
    id,
    src,
    dest,
    mime,
    size,
    checksum,
    username,
    userchannel,
    usernetwork,
    stamp,
    active
   FROM public.items;


ALTER VIEW public.items_sfw OWNER TO f0ckm;

--
-- Name: link_token; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.link_token (
    id integer NOT NULL,
    user_id integer NOT NULL,
    token character varying(64) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamp without time zone DEFAULT (CURRENT_TIMESTAMP + '00:10:00'::interval)
);


ALTER TABLE public.link_token OWNER TO f0ckm;

--
-- Name: link_token_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.link_token_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.link_token_id_seq OWNER TO f0ckm;

--
-- Name: link_token_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.link_token_id_seq OWNED BY public.link_token.id;


--
-- Name: login_attempts; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.login_attempts (
    id integer NOT NULL,
    ip_hash text NOT NULL,
    username text,
    type text NOT NULL,
    attempted_at timestamp with time zone DEFAULT now(),
    success boolean NOT NULL
);


ALTER TABLE public.login_attempts OWNER TO f0ckm;

--
-- Name: login_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.login_attempts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.login_attempts_id_seq OWNER TO f0ckm;

--
-- Name: login_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.login_attempts_id_seq OWNED BY public.login_attempts.id;


--
-- Name: meme_templates; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.meme_templates (
    id integer NOT NULL,
    template_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    url text NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer,
    category character varying(100) DEFAULT 'General'::character varying,
    sub_category text
);


ALTER TABLE public.meme_templates OWNER TO f0ckm;

--
-- Name: meme_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.meme_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.meme_templates_id_seq OWNER TO f0ckm;

--
-- Name: meme_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.meme_templates_id_seq OWNED BY public.meme_templates.id;


--
-- Name: meta_cache; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.meta_cache (
    url text NOT NULL,
    data jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.meta_cache OWNER TO f0ckm;

--
-- Name: notifications; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.notifications (
    id integer NOT NULL,
    user_id integer NOT NULL,
    type character varying(32) NOT NULL,
    reference_id integer NOT NULL,
    item_id integer,
    is_read boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    data jsonb DEFAULT '{}'::jsonb
);


ALTER TABLE public.notifications OWNER TO f0ckm;

--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.notifications_id_seq OWNER TO f0ckm;

--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: private_messages; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.private_messages (
    id bigint NOT NULL,
    sender_id integer NOT NULL,
    recipient_id integer NOT NULL,
    ciphertext text NOT NULL,
    iv text NOT NULL,
    is_read boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.private_messages OWNER TO f0ckm;

--
-- Name: private_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.private_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.private_messages_id_seq OWNER TO f0ckm;

--
-- Name: private_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.private_messages_id_seq OWNED BY public.private_messages.id;


--
-- Name: reports; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.reports (
    id integer NOT NULL,
    reporter_id integer,
    item_id integer,
    comment_id integer,
    user_id integer,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text,
    resolved_by integer,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.reports OWNER TO f0ckm;

--
-- Name: reports_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.reports_id_seq OWNER TO f0ckm;

--
-- Name: reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.reports_id_seq OWNED BY public.reports.id;


--
-- Name: site_settings; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.site_settings (
    key text NOT NULL,
    value text NOT NULL
);


ALTER TABLE public.site_settings OWNER TO f0ckm;

--
-- Name: tags_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.tags_id_seq OWNER TO f0ckm;

--
-- Name: tags; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.tags (
    id integer DEFAULT nextval('public.tags_id_seq'::regclass) NOT NULL,
    tag character varying(255) NOT NULL,
    normalized character varying(255)
);


ALTER TABLE public.tags OWNER TO f0ckm;

--
-- Name: tags_alias; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.tags_alias (
    tag_orig_id integer NOT NULL,
    tag_alias character varying NOT NULL
);


ALTER TABLE public.tags_alias OWNER TO f0ckm;

--
-- Name: user_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.user_id_seq OWNER TO f0ckm;

--
-- Name: user; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public."user" (
    id integer DEFAULT nextval('public.user_id_seq'::regclass) NOT NULL,
    login character varying(255) NOT NULL,
    "user" character varying(255) NOT NULL,
    password character varying(167) NOT NULL,
    admin boolean NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    ban_expires timestamp with time zone,
    banned boolean DEFAULT false,
    ban_reason text,
    is_moderator boolean NOT NULL,
    activated boolean DEFAULT true,
    activation_token text,
    email text,
    reset_token text,
    reset_expires timestamp without time zone,
    last_seen integer DEFAULT 0,
    force_password_change boolean DEFAULT false
);


ALTER TABLE public."user" OWNER TO f0ckm;

--
-- Name: user_api_keys; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.user_api_keys (
    user_id    integer NOT NULL,
    api_key    text    NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_api_keys_pkey PRIMARY KEY (user_id),
    CONSTRAINT user_api_keys_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE,
    CONSTRAINT user_api_keys_api_key_key UNIQUE (api_key)
);

ALTER TABLE public.user_api_keys OWNER TO f0ckm;


--
-- Name: user_alias; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.user_alias (
    userid integer NOT NULL,
    alias character varying(255) NOT NULL,
    type character varying(32) DEFAULT 'discord'::character varying NOT NULL
);

ALTER TABLE ONLY public.user_alias REPLICA IDENTITY FULL;


ALTER TABLE public.user_alias OWNER TO f0ckm;

--
-- Name: user_conversation_states; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.user_conversation_states (
    user_id integer NOT NULL,
    other_id integer NOT NULL,
    is_hidden boolean DEFAULT false
);


ALTER TABLE public.user_conversation_states OWNER TO f0ckm;

--
-- Name: user_dm_keyvault; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.user_dm_keyvault (
    user_id integer NOT NULL,
    salt text NOT NULL,
    iv text NOT NULL,
    ciphertext text NOT NULL,
    version smallint DEFAULT 1,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.user_dm_keyvault OWNER TO f0ckm;

--
-- Name: user_halls; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.user_halls (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    is_private boolean DEFAULT false NOT NULL,
    custom_image boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.user_halls OWNER TO f0ckm;

--
-- Name: user_halls_assign; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.user_halls_assign (
    hall_id integer NOT NULL,
    item_id integer NOT NULL,
    user_id integer NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.user_halls_assign OWNER TO f0ckm;

--
-- Name: user_halls_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.user_halls_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.user_halls_id_seq OWNER TO f0ckm;

--
-- Name: user_halls_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.user_halls_id_seq OWNED BY public.user_halls.id;


--
-- Name: user_options; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.user_options (
    user_id integer NOT NULL,
    mode integer NOT NULL,
    theme character varying(50) NOT NULL,
    avatar integer,
    fullscreen smallint DEFAULT '0'::smallint NOT NULL,
    excluded_tags integer[] DEFAULT '{}'::integer[] NOT NULL,
    avatar_file character varying(255),
    show_motd boolean DEFAULT true,
    strict_mode boolean DEFAULT false,
    use_new_layout boolean DEFAULT false,
    username_color character varying,
    font character varying(255) DEFAULT NULL::character varying,
    disable_autoplay boolean DEFAULT false,
    disable_swiping boolean DEFAULT false,
    description text,
    display_name character varying(60),
    min_xd_score integer DEFAULT 0 NOT NULL,
    show_background boolean,
    ruffle_volume numeric(3,2) DEFAULT NULL::numeric,
    ruffle_background boolean DEFAULT true,
    quote_emojis boolean DEFAULT true NOT NULL,
    embed_youtube_in_comments boolean DEFAULT true NOT NULL,
    hide_koepfe boolean DEFAULT false NOT NULL,
    language text,
    use_alternative_infobox boolean DEFAULT false,
    receive_system_notifications boolean DEFAULT true,
    receive_user_notifications boolean DEFAULT true,
    do_not_disturb boolean DEFAULT false,
    comment_display_mode integer DEFAULT 1,
    force_comment_display_mode integer DEFAULT 0
);


ALTER TABLE public.user_options OWNER TO f0ckm;

--
-- Name: COLUMN user_options.avatar_file; Type: COMMENT; Schema: public; Owner: f0ckm
--

COMMENT ON COLUMN public.user_options.avatar_file IS 'Custom uploaded avatar filename, stored in public/a/';


--
-- Name: user_pubkeys; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.user_pubkeys (
    user_id integer NOT NULL,
    pubkey text NOT NULL,
    fingerprint text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.user_pubkeys OWNER TO f0ckm;

--
-- Name: user_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.user_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.user_sessions_id_seq OWNER TO f0ckm;

--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.user_sessions (
    id integer DEFAULT nextval('public.user_sessions_id_seq'::regclass) NOT NULL,
    user_id integer NOT NULL,
    session character varying(64) NOT NULL,
    browser character varying(255) NOT NULL,
    created_at integer NOT NULL,
    last_used integer NOT NULL,
    last_action character varying(255) NOT NULL,
    kmsi smallint DEFAULT '0'::smallint NOT NULL,
    csrf_token character varying(64)
);


ALTER TABLE public.user_sessions OWNER TO f0ckm;

--
-- Name: user_video_views; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.user_video_views (
    user_id integer NOT NULL,
    video_id integer NOT NULL,
    view_count integer DEFAULT 1,
    last_viewed timestamp without time zone DEFAULT now()
);


ALTER TABLE public.user_video_views OWNER TO f0ckm;

--
-- Name: user_warnings; Type: TABLE; Schema: public; Owner: f0ckm
--

CREATE TABLE public.user_warnings (
    id integer NOT NULL,
    user_id integer,
    admin_id integer,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    acknowledged boolean DEFAULT false
);


ALTER TABLE public.user_warnings OWNER TO f0ckm;

--
-- Name: user_warnings_id_seq; Type: SEQUENCE; Schema: public; Owner: f0ckm
--

CREATE SEQUENCE public.user_warnings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.user_warnings_id_seq OWNER TO f0ckm;

--
-- Name: user_warnings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: f0ckm
--

ALTER SEQUENCE public.user_warnings_id_seq OWNED BY public.user_warnings.id;


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: comments id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.comments ALTER COLUMN id SET DEFAULT nextval('public.comments_id_seq'::regclass);


--
-- Name: custom_emojis id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.custom_emojis ALTER COLUMN id SET DEFAULT nextval('public.custom_emojis_id_seq'::regclass);


--
-- Name: discord_queue id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.discord_queue ALTER COLUMN id SET DEFAULT nextval('public.discord_queue_id_seq'::regclass);


--
-- Name: global_chat id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.global_chat ALTER COLUMN id SET DEFAULT nextval('public.global_chat_id_seq'::regclass);


--
-- Name: halls id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.halls ALTER COLUMN id SET DEFAULT nextval('public.halls_id_seq'::regclass);


--
-- Name: invite_tokens id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.invite_tokens ALTER COLUMN id SET DEFAULT nextval('public.invite_tokens_id_seq'::regclass);


--
-- Name: link_token id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.link_token ALTER COLUMN id SET DEFAULT nextval('public.link_token_id_seq'::regclass);


--
-- Name: login_attempts id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.login_attempts ALTER COLUMN id SET DEFAULT nextval('public.login_attempts_id_seq'::regclass);


--
-- Name: meme_templates id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.meme_templates ALTER COLUMN id SET DEFAULT nextval('public.meme_templates_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: private_messages id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.private_messages ALTER COLUMN id SET DEFAULT nextval('public.private_messages_id_seq'::regclass);


--
-- Name: reports id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.reports ALTER COLUMN id SET DEFAULT nextval('public.reports_id_seq'::regclass);


--
-- Name: user_halls id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_halls ALTER COLUMN id SET DEFAULT nextval('public.user_halls_id_seq'::regclass);


--
-- Name: user_warnings id; Type: DEFAULT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_warnings ALTER COLUMN id SET DEFAULT nextval('public.user_warnings_id_seq'::regclass);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: comment_subscriptions comment_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.comment_subscriptions
    ADD CONSTRAINT comment_subscriptions_pkey PRIMARY KEY (user_id, item_id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: custom_emojis custom_emojis_name_key; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.custom_emojis
    ADD CONSTRAINT custom_emojis_name_key UNIQUE (name);


--
-- Name: custom_emojis custom_emojis_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.custom_emojis
    ADD CONSTRAINT custom_emojis_pkey PRIMARY KEY (id);


--
-- Name: discord_queue discord_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.discord_queue
    ADD CONSTRAINT discord_queue_pkey PRIMARY KEY (id);


--
-- Name: global_chat global_chat_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.global_chat
    ADD CONSTRAINT global_chat_pkey PRIMARY KEY (id);


--
-- Name: global_chat_settings global_chat_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.global_chat_settings
    ADD CONSTRAINT global_chat_settings_pkey PRIMARY KEY (key);


--
-- Name: halls_assign halls_assign_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.halls_assign
    ADD CONSTRAINT halls_assign_pkey PRIMARY KEY (hall_id, item_id);


--
-- Name: halls halls_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.halls
    ADD CONSTRAINT halls_pkey PRIMARY KEY (id);


--
-- Name: halls halls_slug_key; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.halls
    ADD CONSTRAINT halls_slug_key UNIQUE (slug);


--
-- Name: favorites idx_16521_primary; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT idx_16521_primary PRIMARY KEY (user_id, item_id);


--
-- Name: items idx_16526_primary; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT idx_16526_primary PRIMARY KEY (id);


--
-- Name: user idx_16554_primary; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT idx_16554_primary PRIMARY KEY (id);


--
-- Name: user_options idx_16567_user_id; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_options
    ADD CONSTRAINT idx_16567_user_id UNIQUE (user_id);


--
-- Name: user_sessions idx_16572_primary; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT idx_16572_primary PRIMARY KEY (id);


--
-- Name: invite_tokens invite_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.invite_tokens
    ADD CONSTRAINT invite_tokens_pkey PRIMARY KEY (id);


--
-- Name: invite_tokens invite_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.invite_tokens
    ADD CONSTRAINT invite_tokens_token_key UNIQUE (token);


--
-- Name: items items_checksum; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_checksum UNIQUE (checksum);


--
-- Name: link_token link_token_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.link_token
    ADD CONSTRAINT link_token_pkey PRIMARY KEY (id);


--
-- Name: link_token link_token_token_key; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.link_token
    ADD CONSTRAINT link_token_token_key UNIQUE (token);


--
-- Name: login_attempts login_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.login_attempts
    ADD CONSTRAINT login_attempts_pkey PRIMARY KEY (id);


--
-- Name: meme_templates meme_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.meme_templates
    ADD CONSTRAINT meme_templates_pkey PRIMARY KEY (id);


--
-- Name: meme_templates meme_templates_template_id_key; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.meme_templates
    ADD CONSTRAINT meme_templates_template_id_key UNIQUE (template_id);


--
-- Name: meta_cache meta_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.meta_cache
    ADD CONSTRAINT meta_cache_pkey PRIMARY KEY (url);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: private_messages private_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.private_messages
    ADD CONSTRAINT private_messages_pkey PRIMARY KEY (id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: site_settings site_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.site_settings
    ADD CONSTRAINT site_settings_pkey PRIMARY KEY (key);


--
-- Name: tags_alias tags_alias_tag_alias_tag_orig_id; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.tags_alias
    ADD CONSTRAINT tags_alias_tag_alias_tag_orig_id UNIQUE (tag_alias, tag_orig_id);


--
-- Name: tags_alias tags_alias_tag_orig_id; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.tags_alias
    ADD CONSTRAINT tags_alias_tag_orig_id PRIMARY KEY (tag_orig_id);


--
-- Name: tags_assign tags_assign_item_id_tag_id_primary; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.tags_assign
    ADD CONSTRAINT tags_assign_item_id_tag_id_primary PRIMARY KEY (item_id, tag_id);


--
-- Name: tags_assign tags_assign_item_id_tag_id_unique; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.tags_assign
    ADD CONSTRAINT tags_assign_item_id_tag_id_unique UNIQUE (item_id, tag_id);


--
-- Name: tags tags_id; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_id PRIMARY KEY (id);


--
-- Name: user_conversation_states user_conversation_states_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_conversation_states
    ADD CONSTRAINT user_conversation_states_pkey PRIMARY KEY (user_id, other_id);


--
-- Name: user_dm_keyvault user_dm_keyvault_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_dm_keyvault
    ADD CONSTRAINT user_dm_keyvault_pkey PRIMARY KEY (user_id);


--
-- Name: user_halls_assign user_halls_assign_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_halls_assign
    ADD CONSTRAINT user_halls_assign_pkey PRIMARY KEY (hall_id, item_id);


--
-- Name: user_halls user_halls_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_halls
    ADD CONSTRAINT user_halls_pkey PRIMARY KEY (id);


--
-- Name: user_halls user_halls_user_id_slug_key; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_halls
    ADD CONSTRAINT user_halls_user_id_slug_key UNIQUE (user_id, slug);


--
-- Name: user user_login_unique; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_login_unique UNIQUE (login);


--
-- Name: user user_name_unique; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_name_unique UNIQUE ("user");


--
-- Name: user user_email_unique; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_unique UNIQUE (email);


--
-- Name: user_options user_options_user_id; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_options
    ADD CONSTRAINT user_options_user_id PRIMARY KEY (user_id);


--
-- Name: user_pubkeys user_pubkeys_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_pubkeys
    ADD CONSTRAINT user_pubkeys_pkey PRIMARY KEY (user_id);


--
-- Name: user_video_views user_video_views_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_video_views
    ADD CONSTRAINT user_video_views_pkey PRIMARY KEY (user_id, video_id);


--
-- Name: user_warnings user_warnings_pkey; Type: CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_warnings
    ADD CONSTRAINT user_warnings_pkey PRIMARY KEY (id);


--
-- Name: idx_audit_log_action; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_audit_log_action ON public.audit_log USING btree (action);


--
-- Name: idx_audit_log_created_at; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_audit_log_created_at ON public.audit_log USING btree (created_at);


--
-- Name: idx_audit_log_user_id; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_audit_log_user_id ON public.audit_log USING btree (user_id);


--
-- Name: idx_comments_is_pinned; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_comments_is_pinned ON public.comments USING btree (is_pinned) WHERE (is_pinned = true);


--
-- Name: idx_comments_item_id; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_comments_item_id ON public.comments USING btree (item_id);


--
-- Name: idx_comments_user_id; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_comments_user_id ON public.comments USING btree (user_id);


--
-- Name: idx_discord_queue_sent; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_discord_queue_sent ON public.discord_queue USING btree (sent) WHERE (sent = false);


--
-- Name: idx_global_chat_created_at; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_global_chat_created_at ON public.global_chat USING btree (created_at DESC);


--
-- Name: idx_items_active_id; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_items_active_id ON public.items USING btree (id) WHERE (active = true);


--
-- Name: idx_items_is_deleted; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_items_is_deleted ON public.items USING btree (is_deleted) WHERE (is_deleted = false);


--
-- Name: idx_items_is_purged; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_items_is_purged ON public.items USING btree (is_purged) WHERE (is_purged = true);


--
-- Name: idx_items_pinned_id; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_items_pinned_id ON public.items USING btree (is_pinned DESC, id DESC);


--
-- Name: idx_items_username; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_items_username ON public.items USING btree (username);


--
-- Name: idx_items_username_lower; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_items_username_lower ON public.items USING btree (lower((username)::text));


--
-- Name: idx_items_xd_score; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_items_xd_score ON public.items USING btree (xd_score) WHERE (xd_score > 0);


--
-- Name: idx_link_token_token; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_link_token_token ON public.link_token USING btree (token);


--
-- Name: idx_login_attempts_ip_time; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_login_attempts_ip_time ON public.login_attempts USING btree (ip_hash, attempted_at DESC);


--
-- Name: idx_login_attempts_username_time; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_login_attempts_username_time ON public.login_attempts USING btree (username, attempted_at DESC);


--
-- Name: idx_notifications_unread; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_notifications_unread ON public.notifications USING btree (user_id) WHERE (is_read = false);


--
-- Name: idx_notifications_user_id; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id);


--
-- Name: idx_pm_conversation; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_pm_conversation ON public.private_messages USING btree (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), created_at DESC);


--
-- Name: idx_pm_recipient; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_pm_recipient ON public.private_messages USING btree (recipient_id, created_at DESC);


--
-- Name: idx_pm_sender; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_pm_sender ON public.private_messages USING btree (sender_id, created_at DESC);


--
-- Name: idx_reports_status; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_reports_status ON public.reports USING btree (status);


--
-- Name: idx_ucs_user_hidden; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_ucs_user_hidden ON public.user_conversation_states USING btree (user_id, is_hidden);


--
-- Name: idx_user_alias_alias; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_user_alias_alias ON public.user_alias USING btree (alias);


--
-- Name: idx_user_alias_type; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_user_alias_type ON public.user_alias USING btree (type);


--
-- Name: idx_user_alias_userid; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_user_alias_userid ON public.user_alias USING btree (userid);


--
-- Name: idx_user_api_keys_api_key; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_user_api_keys_api_key ON public.user_api_keys USING btree (api_key);


--
-- Name: idx_user_halls_assign_hall; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_user_halls_assign_hall ON public.user_halls_assign USING btree (hall_id);


--
-- Name: idx_user_halls_assign_item; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_user_halls_assign_item ON public.user_halls_assign USING btree (item_id);


--
-- Name: idx_user_halls_user_id; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_user_halls_user_id ON public.user_halls USING btree (user_id);


--
-- Name: idx_user_last_seen; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_user_last_seen ON public."user" USING btree (last_seen);


--
-- Name: idx_user_warnings_user_status; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX idx_user_warnings_user_status ON public.user_warnings USING btree (user_id, acknowledged);


--
-- Name: items_phash; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX items_phash ON public.items USING btree (phash);


--
-- Name: tags_assign_tag_id_idx; Type: INDEX; Schema: public; Owner: f0ckm
--

CREATE INDEX tags_assign_tag_id_idx ON public.tags_assign USING btree (tag_id);


--
-- Name: items_li _RETURN; Type: RULE; Schema: public; Owner: f0ckm
--

CREATE OR REPLACE VIEW public.items_li AS
 SELECT items.id,
    items.src,
    items.dest,
    items.mime,
    items.size,
    items.checksum,
    items.username,
    items.userchannel,
    items.usernetwork,
    items.stamp
   FROM ((public.items
     JOIN public.tags_assign ta1 ON (((ta1.tag_id = 1) AND (ta1.item_id = items.id))))
     JOIN public.tags_assign ta2 ON (((NOT (ta2.tag_id IN ( SELECT tags_nsfp.id
           FROM public.tags_nsfp))) AND (ta2.item_id = items.id))))
  WHERE items.active
  GROUP BY items.id;


--
-- Name: global_chat global_chat_notify; Type: TRIGGER; Schema: public; Owner: f0ckm
--

CREATE TRIGGER global_chat_notify AFTER INSERT ON public.global_chat FOR EACH ROW EXECUTE FUNCTION public.notify_global_chat();


--
-- Name: tags_assign tags_assign_ad; Type: TRIGGER; Schema: public; Owner: f0ckm
--

CREATE TRIGGER tags_assign_ad AFTER DELETE ON public.tags_assign FOR EACH ROW EXECUTE FUNCTION public.delete_unused_tags();


--
-- Name: tags tags_bi; Type: TRIGGER; Schema: public; Owner: f0ckm
--

CREATE TRIGGER tags_bi BEFORE INSERT ON public.tags FOR EACH ROW EXECUTE FUNCTION public.fill_normalized();


--
-- Name: tags tags_bu; Type: TRIGGER; Schema: public; Owner: f0ckm
--

CREATE TRIGGER tags_bu BEFORE UPDATE ON public.tags FOR EACH ROW EXECUTE FUNCTION public.fill_normalized();


--
-- Name: comments trg_comments_xd_score; Type: TRIGGER; Schema: public; Owner: f0ckm
--

CREATE TRIGGER trg_comments_xd_score AFTER INSERT OR DELETE OR UPDATE OF content, is_deleted ON public.comments FOR EACH ROW EXECUTE FUNCTION public.trg_update_xd_score();


--
-- Name: comments trigger_notify_activity; Type: TRIGGER; Schema: public; Owner: f0ckm
--

CREATE TRIGGER trigger_notify_activity AFTER INSERT ON public.comments FOR EACH ROW EXECUTE FUNCTION public.notify_activity();


--
-- Name: notifications trigger_notify_notification; Type: TRIGGER; Schema: public; Owner: f0ckm
--

CREATE TRIGGER trigger_notify_notification AFTER INSERT OR UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.notify_notification();


--
-- Name: private_messages trigger_notify_private_message; Type: TRIGGER; Schema: public; Owner: f0ckm
--

CREATE TRIGGER trigger_notify_private_message AFTER INSERT ON public.private_messages FOR EACH ROW EXECUTE FUNCTION public.notify_private_message();


--
-- Name: comment_subscriptions comment_subscriptions_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.comment_subscriptions
    ADD CONSTRAINT comment_subscriptions_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: comment_subscriptions comment_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.comment_subscriptions
    ADD CONSTRAINT comment_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: comments comments_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: comments comments_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.comments(id) ON DELETE SET NULL;


--
-- Name: comments comments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: discord_queue discord_queue_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.discord_queue
    ADD CONSTRAINT discord_queue_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: discord_queue discord_queue_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.discord_queue
    ADD CONSTRAINT discord_queue_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: favorites favorites_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: favorites favorites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: global_chat global_chat_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.global_chat
    ADD CONSTRAINT global_chat_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: halls_assign halls_assign_hall_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.halls_assign
    ADD CONSTRAINT halls_assign_hall_id_fkey FOREIGN KEY (hall_id) REFERENCES public.halls(id) ON DELETE CASCADE;


--
-- Name: halls_assign halls_assign_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.halls_assign
    ADD CONSTRAINT halls_assign_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: halls_assign halls_assign_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.halls_assign
    ADD CONSTRAINT halls_assign_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: invite_tokens invite_tokens_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.invite_tokens
    ADD CONSTRAINT invite_tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id);


--
-- Name: invite_tokens invite_tokens_used_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.invite_tokens
    ADD CONSTRAINT invite_tokens_used_by_fkey FOREIGN KEY (used_by) REFERENCES public."user"(id);


--
-- Name: link_token link_token_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.link_token
    ADD CONSTRAINT link_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: private_messages private_messages_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.private_messages
    ADD CONSTRAINT private_messages_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: private_messages private_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.private_messages
    ADD CONSTRAINT private_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: reports reports_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id) ON DELETE CASCADE;


--
-- Name: reports reports_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: reports reports_reporter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: reports reports_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: reports reports_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: tags_alias tags_alias_tag_orig_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.tags_alias
    ADD CONSTRAINT tags_alias_tag_orig_id_fkey FOREIGN KEY (tag_orig_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: tags_assign tags_assign_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.tags_assign
    ADD CONSTRAINT tags_assign_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: tags_assign tags_assign_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.tags_assign
    ADD CONSTRAINT tags_assign_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: tags_assign tags_assign_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.tags_assign
    ADD CONSTRAINT tags_assign_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE SET DEFAULT;


--
-- Name: user_conversation_states user_conversation_states_other_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_conversation_states
    ADD CONSTRAINT user_conversation_states_other_id_fkey FOREIGN KEY (other_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: user_conversation_states user_conversation_states_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_conversation_states
    ADD CONSTRAINT user_conversation_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: user_dm_keyvault user_dm_keyvault_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_dm_keyvault
    ADD CONSTRAINT user_dm_keyvault_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: user_halls_assign user_halls_assign_hall_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_halls_assign
    ADD CONSTRAINT user_halls_assign_hall_id_fkey FOREIGN KEY (hall_id) REFERENCES public.user_halls(id) ON DELETE CASCADE;


--
-- Name: user_halls_assign user_halls_assign_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_halls_assign
    ADD CONSTRAINT user_halls_assign_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: user_halls_assign user_halls_assign_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_halls_assign
    ADD CONSTRAINT user_halls_assign_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: user_halls user_halls_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_halls
    ADD CONSTRAINT user_halls_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: user_options user_options_avatar_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_options
    ADD CONSTRAINT user_options_avatar_fkey FOREIGN KEY (avatar) REFERENCES public.items(id) ON DELETE SET DEFAULT;


--
-- Name: user_options user_options_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_options
    ADD CONSTRAINT user_options_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: user_pubkeys user_pubkeys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_pubkeys
    ADD CONSTRAINT user_pubkeys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: user_video_views user_video_views_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_video_views
    ADD CONSTRAINT user_video_views_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: user_video_views user_video_views_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_video_views
    ADD CONSTRAINT user_video_views_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: user_warnings user_warnings_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_warnings
    ADD CONSTRAINT user_warnings_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: user_warnings user_warnings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_warnings
    ADD CONSTRAINT user_warnings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: user_api_keys user_api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: f0ckm
--

ALTER TABLE ONLY public.user_api_keys
    ADD CONSTRAINT user_api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: alltables; Type: PUBLICATION; Schema: -; Owner: f0ckm
--

CREATE PUBLICATION alltables FOR ALL TABLES WITH (publish = 'insert, update, delete, truncate');


ALTER PUBLICATION alltables OWNER TO f0ckm;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: f0ckm
--

REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO PUBLIC;


--
-- PostgreSQL database dump complete
--

SET search_path TO public;

-- Migration to add user_ips table for historical IP logging
CREATE TABLE IF NOT EXISTS user_ips (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    ip TEXT NOT NULL,
    first_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, ip)
);

CREATE INDEX IF NOT EXISTS idx_user_ips_user_id ON user_ips(user_id);

-- Add IP tracking to user_sessions for "current" IP view
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS ip TEXT;

-- DM encrypted attachments (Migration 005)
CREATE TABLE IF NOT EXISTS public.dm_attachments (
    id            bigserial PRIMARY KEY,
    sender_id     integer NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    recipient_id  integer NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    iv            text NOT NULL,
    file_path     text NOT NULL,
    original_name text NOT NULL DEFAULT '',
    mime_hint     text NOT NULL DEFAULT '',
    size_bytes    integer NOT NULL DEFAULT 0,
    created_at    timestamp with time zone DEFAULT now(),
    expires_at    timestamp with time zone DEFAULT (now() + interval '90 days')
);

CREATE INDEX IF NOT EXISTS idx_dm_att_sender    ON public.dm_attachments(sender_id);
CREATE INDEX IF NOT EXISTS idx_dm_att_recipient ON public.dm_attachments(recipient_id);
CREATE INDEX IF NOT EXISTS idx_dm_att_expires   ON public.dm_attachments(expires_at);

-- DM message edit/delete support (Migration 006)
ALTER TABLE private_messages
    ADD COLUMN IF NOT EXISTS edited_at timestamp with time zone DEFAULT NULL;

\unrestrict RMNKNzVQLV2ZcwmM3bmhglTot5nRoju9FmRyi3eUMfNy6iJUBfHRIgXnbrpJikG
