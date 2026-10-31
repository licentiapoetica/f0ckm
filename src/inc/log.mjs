import fs from "fs";

const logger = ["debug", "info", "error"];
const logfiles = logger.reduce((a, b) => ({...a, [b]: fs.createWriteStream(`./logs/${~~(Date.now() / 1000)}_${b}.log`)}), {});

export default new Proxy({}, {
  get: (_, prop) => (msg, timestamp = new Date().toLocaleString()) =>
    logger.includes(prop) &&
    logfiles[prop].write(JSON.stringify({
      level: prop,
      message: msg,
      timestamp: timestamp
    }) + "\n")// &&
    //console.log(timestamp, prop, msg)
});
