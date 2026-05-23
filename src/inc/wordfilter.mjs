import db from "./sql.mjs";

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces words matching database rules inside comments.
 * @param {string} content 
 * @returns {Promise<string>} The filtered comment text.
 */
export async function applyWordFilter(content) {
  if (!content || typeof content !== 'string') return content;
  try {
    const filters = await db`SELECT word, replacement FROM wordfilter`;
    if (filters.length === 0) return content;

    let filtered = content;
    for (const f of filters) {
      const escaped = escapeRegExp(f.word);
      const startBoundary = /^\w/.test(f.word) ? '\\b' : '';
      const endBoundary = /\w$/.test(f.word) ? '\\b' : '';
      
      const regex = new RegExp(`${startBoundary}${escaped}${endBoundary}`, 'gi');
      filtered = filtered.replace(regex, f.replacement);
    }
    return filtered;
  } catch (err) {
    console.error('[WORDFILTER] Error applying filter:', err);
    return content;
  }
}
