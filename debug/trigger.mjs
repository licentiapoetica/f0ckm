import { promises as fs } from "fs";

(async () => {
  const _args = process.argv.slice(2);
  const _e = {
    network: "console",
    message: _args.join(" "),
    args: _args.slice(1),
    channel: "console",
    user: {
      prefix: "console!console@console",
      nick: "console",
      username: "console",
      account: "console"
    },
    reply: (...args) => console.log(args),
    replyAction: (...args) => console.log(args),
    replyNotice: (...args) => console.log(args)
  };

  const trigger = (await Promise.all((await fs.readdir("./src/inc/trigger"))
    .filter(f => f.endsWith(".mjs"))
    .map(async t => await (await import(`../src/inc/trigger/${t}`)).default())
  )).filter(t => t[0].call.test(_e.message)).map(t => ({ name: t[0].name, f: t[0].f }));

  try {
    if(trigger.length === 0)
      return console.error("no matches");
    console.log(`triggered > ${trigger[0].name} (${_e.message})`);
    await trigger[0].f(_e);
  } catch(err) {
    console.error(err);
  }
})();
