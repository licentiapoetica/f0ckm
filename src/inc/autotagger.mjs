import fetch from 'flumm-fetch';
import cfg from './config.mjs';

export default new class autotagger {
  async isNSFW(filename, filesize) {
    let opts = {
      method: 'POST',
    };
    let apiurl;
    if(filesize < 4194304) {
      apiurl = cfg.apis.nsfw1.url;
      opts.headers = cfg.apis.nsfw1.headers;
      opts.body = JSON.stringify({
        DataRepresentation: "URL",
        Value: `${cfg.main.url.full}/b/${filename}`
      });
    }
    else {
      apiurl = cfg.apis.nsfw2.url;
      opts.headers = cfg.apis.nsfw2.headers;
      opts.body = JSON.stringify({
        url: `${cfg.main.url.full}/b/${filename}`
      })
    }
    const res = await (await fetch(apiurl, opts)).json();

    if(filesize < 4194304)
      return res.IsImageAdultClassified || res.RacyClassificationScore > 0.6;
    else
      return res.unsafe;
  };
};
