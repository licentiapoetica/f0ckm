import cfg from "../config.mjs";
import fs from "fs/promises";
import path from "path";

export default (router, tpl) => {
  router.static({
    dir: cfg.paths.b,
    route: /^\/b\//
  });

  router.static({
    dir: cfg.paths.c,
    route: /^\/c\//
  });

  router.static({
    dir: cfg.paths.emojis,
    route: /^\/s\/emojis\//
  });

  router.static({
    dir: cfg.paths.koepfe,
    route: /^\/s\/koepfe\//
  });

  router.static({
    dir: path.join(path.resolve(), 'node_modules/@ruffle-rs/ruffle'),
    route: /^\/s\/ruffle\//
  });

  router.static({
    dir: cfg.paths.s,
    route: /^\/s\//
  });

  router.static({
    dir: cfg.paths.t,
    route: /^\/t\//
  });

  router.static({
    dir: cfg.paths.ca,
    route: /^\/ca\//
  });

  router.static({
    dir: cfg.paths.memes,
    route: /^\/memes\//
  });

  router.static({
    dir: cfg.paths.a,
    route: /^\/a\//
  });

  router.get(/^\/robots\.txt$/, async (req, res) => {
    res.reply({
      type: "text/plain",
      body: await fs.readFile(path.join(cfg.paths.s, "../robots.txt"), "utf-8")
    });
  });

  router.get(/^\/manifest\.json$/, async (req, res) => {
    res.reply({
      type: "application/json",
      body: await fs.readFile(path.join(cfg.paths.s, "../manifest.json"), "utf-8")
    });
  });

  router.get(/^\/sw\.js$/, async (req, res) => {
    res.reply({
      type: "application/javascript",
      body: await fs.readFile(path.join(cfg.paths.s, "../sw.js"), "utf-8")
    });
  });
};
