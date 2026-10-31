ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS categories text[] DEFAULT '{}';
