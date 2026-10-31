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

    // Custom meme template page
    router.get(/^\/meme\/custom$/, lib.userauth, async (req, res) => {
        if (!cfg.websrv.meme_creator) {
            res.writeHead(404).end('Not Found');
            return;
        }
        res.reply({
            body: tpl.render('meme-creator', {
                template: {
                    id: 'custom',
                    name: 'Custom Template',
                    url: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="%231a1a1b"/><text x="50%25" y="50%25" fill="%23888888" font-family="sans-serif" font-size="24" dominant-baseline="middle" text-anchor="middle">Click %22Choose Image%22 or Drag and Drop here</text></svg>',
                    category: 'Custom',
                    sub_category: ''
                },
                page_meta: {
                    title: 'Create Meme - Custom Template',
                    description: 'Create a meme using your own custom template',
                    url: `https://${cfg.main.url.domain}/meme/custom`
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
