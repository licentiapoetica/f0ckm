export default (obj, word) => {
  if(typeof obj !== "object")
    return false;
  return obj.map(tmp => {
    let rscore = 0
      , startat = 0
      , cscore
      , score;
    const stringNorm = (tmp.tag || "").normalize('NFC').toLowerCase();
    const wordNorm = (word || "").normalize('NFC').toLowerCase();

    for(let i = 0; i < wordNorm.length; i++) {
      const idxOf = stringNorm.indexOf(wordNorm[i], startat);
      if(-1 === idxOf)
        return { score: 0 };
      if(startat === idxOf)
        cscore = 0.7;
      else {
        cscore = 0.1;
        if(stringNorm[idxOf - 1] === ' ')
          cscore += 0.8;
      }
      if(stringNorm[idxOf] === wordNorm[i])
        cscore += 0.1;
      rscore += cscore;
      startat = idxOf + 1;
    }
    score = 0.5 * (rscore / stringNorm.length + rscore / wordNorm.length);
    if(wordNorm[0] === stringNorm[0] && score < 0.85)
      score += 0.15;

    return {
      ...tmp,
      score: score
    };
  }).filter(t => t.score > 0).sort((a, b) => b.score - a.score);
};
