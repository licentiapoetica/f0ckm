import logger from "../log.mjs";

export default async bot => {

  return [{
    name: "error",
    listener: "error",
    f: e => {
      logger.error(e);
    }
  }];
};
