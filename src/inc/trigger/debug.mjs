import { getLevel } from "../admin.mjs";
import lib from "../lib.mjs";
import fetch from "flumm-fetch";
import vm from "vm";

let maxoutput = 750;
let context = vm.createContext({
  e: null,
  bot: null,
  admins: null,
  fetch,
  lib,
  console,

  a: null,
  resolve: null
});

export default async bot => {

  return [{
    name: "level",
    call: /^!level (.*)/i,
    active: true,
    f: async e => {
      const user = e.message.trim().substring(7);
      await e.reply( JSON.stringify( getLevel( e.self.user.get(user) || {} ) ) );
    }
  }, {
    name: "self",
    call: /^!self$/i,
    active: true,
    f: async e => {
      await e.reply( JSON.stringify( e.user ) );
    }
  }, {
    name: "sandbox_debug",
    call: /^\!f0ck debug (.*)/i,
    active: true,
    level: 100,
    f: async e => {
      const args = e.message.trim().substring(12);

      context.e = e;
      context.bot = bot;
      context.level = getLevel;
      context.hasTag = lib.hasTag;
      context.a = null;

      await new Promise(resolve => {
        context.resolve = resolve;
        const code = "Promise.resolve().then(async result => { a = await (async () => "+args+")(); resolve(); }).catch(err => { a = err; resolve(); })";
        const script = new vm.Script(code);
        script.runInContext(context);
      });

      let output = JSON.stringify(context.a);
      if(output.length > maxoutput)
        return await e.reply(`fuggg, Ausgabe wäre viel zu lang! (${output.length} Zeichen :DDDDDD)`);
      else
        return await e.reply(output);
    }
  }];
};
