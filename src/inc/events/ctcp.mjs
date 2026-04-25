import logger from "../log.mjs";

const versions = [
  "AmIRC.1 (8 Bit) for Commodore Amiga 500",
  "HexChat 0.72 [x86] / Windows 95c [500MHz]"
];

export default async bot => {

  return [{
    name: "version",
    listener: "ctcp:version",
    f: e => {
      logger.info(`${e.network} -> ${e.channel} -> ${e.user.nick}: ctcp:version ${e.message}`);
      e.write(`notice ${e.user.nick} :\u0001VERSION ${versions[~~(Math.random() * versions.length)]}\u0001`);
    }
  }, {
    name: "ping",
    listener: "ctcp:ping",
    f: e => {
      logger.info(`${e.network} -> ${e.channel} -> ${e.user.nick}: ctcp:ping ${e.message}`);
      e.write(`notice ${e.user.nick} :${e.message}`);
    }
  }];
};
