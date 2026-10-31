import config from "./config.mjs";

export const getLevel = user => {
  let ret = {
    level: 0,
    verified: false
  };
  if (typeof user !== "object")
    return "user has to be an object!";
  if (!user.prefix)
    return ret;
  
  let admin;
  if(admin = config.admins.filter(e => e.prefix === user.prefix)[0]) {
    ret = {
      level: admin.level,
      verified: true
    };
  }

  return ret;
};
