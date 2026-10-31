-- Fix items with NULL visibility (should default to 0 = public)
UPDATE items SET visibility = 0 WHERE visibility IS NULL;
