import lib from "../lib.mjs";
import cfg from "../config.mjs";
import db from "../sql.mjs";

// templates are now fetched from the database

export default (router, tpl) => {
    // Template selection page
    router.get(/^\/meme$/, lib.userauth, async (req, res) => {
        if (!cfg.websrv.meme_creator) {
            res.writeHead(404).end('Not Found');
            return;
        }
        const templates = await db`SELECT template_id as id, name, url, category, sub_category FROM meme_templates ORDER BY created_at DESC`;
        
        // Extract unique categories for filtering
        const categories = ['All', ...new Set(templates.map(t => t.category || 'General'))].sort();

        res.reply({
            body: tpl.render('meme-select', {
                templates: templates,
                categories: categories,
                page_meta: {
                    title: 'Meme Creator - Select Template',
                    description: 'Select a template to create your meme',
                    url: `https://${cfg.main.url.domain}/meme`
                }
            }, req)
        });
    });

    // Meme creator page
    router.get(/^\/meme\/(?<id>[a-z0-9-]+)$/, lib.userauth, async (req, res) => {
        if (!cfg.websrv.meme_creator) {
            res.writeHead(404).end('Not Found');
            return;
        }
        const templateId = req.params?.id || req.url.pathname.match(/\/meme\/([a-z0-9-]+)/)?.[1];
        const templateSearch = await db`SELECT template_id as id, name, url, category, sub_category FROM meme_templates WHERE template_id = ${templateId} LIMIT 1`;
        const template = templateSearch[0];

        if (!template) {
            res.writeHead(404).end('Template not found');
            return;
        }

        res.reply({
            body: tpl.render('meme-creator', {
                template: template,
                page_meta: {
                    title: `Create Meme - ${template.name}`,
                    description: `Create a meme using the ${template.name} template`,
                    url: `https://${cfg.main.url.domain}/meme/${templateId}`
                }
            }, req)
        });
    });

    return router;
};
