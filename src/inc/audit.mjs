import db from "./sql.mjs";

export default new class {
    /**
     * Log an action to the audit log.
     * @param {number} userId - The ID of the user performing the action.
     * @param {string} action - Short description of the action (e.g. 'delete_item').
     * @param {string} targetType - The type of target (e.g. 'item', 'comment', 'user').
     * @param {string} targetId - The ID of the target.
     * @param {object} details - Additional JSON details.
     */
    async log(userId, action, targetType, targetId, details = {}) {
        try {
            await db`
                INSERT INTO audit_log (user_id, action, target_type, target_id, details)
                VALUES (${userId}, ${action}, ${targetType}, ${targetId}, ${db.json(details)})
            `;
            console.log(`[AUDIT] User ${userId} performed ${action} on ${targetType}:${targetId}`);
        } catch (err) {
            console.error('[AUDIT] Failed to write log:', err);
        }
    }
};
