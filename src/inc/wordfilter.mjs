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
      const regex = new RegExp(escaped, 'gi');
      filtered = filtered.replace(regex, (match) => {
        // 1. Check if the matched substring is entirely UPPERCASE
        if (match === match.toUpperCase() && match !== match.toLowerCase()) {
          return f.replacement.toUpperCase();
        }
        // 2. Check if the matched substring is Capitalized / Titlecase
        if (match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()) {
          return f.replacement.charAt(0).toUpperCase() + f.replacement.slice(1);
        }
        // 3. Check if the matched substring is lowercase
        if (match === match.toLowerCase()) {
          return f.replacement.toLowerCase();
        }
        // Fallback to exact replacement string
        return f.replacement;
      });
    }
    return filtered;
  } catch (err) {
    console.error('[WORDFILTER] Error applying filter:', err);
    return content;
  }
}
