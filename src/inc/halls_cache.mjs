import db from "./sql.mjs";

let hallsCache = [];

export const updateHallsCache = async () => {
    try {
        hallsCache = await db`SELECT id, name, slug, rating FROM halls ORDER BY name ASC`;
    } catch (e) {
        console.error('[HALLS CACHE] Failed to update:', e);
    }
};

export const getHalls = () => hallsCache;
