import logger from "../log.mjs";

export default async bot => {

  return [{
    name: "info",
    listener: "info",
    f: e => {
      logger.debug(e);
    }
  }, {
    name: "debug",
    listener: "debug",
    f: e => {
      logger.debug(e);
    }
  }];
};
