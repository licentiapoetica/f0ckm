export default (obj, word) => {
  if(typeof obj !== "object")
    return false;
  return obj.map(tmp => {
    let rscore = 0
      , startat = 0
      , string = tmp.tag
      , cscore
      , score;
    for(let i = 0; i < word.length; i++) {
      const idxOf = string.toLowerCase().indexOf(word.toLowerCase()[i], startat);
      if(-1 === idxOf)
        return { score: 0 };
      if(startat === idxOf)
        cscore = 0.7;
      else {
        cscore = 0.1;
        if(string[idxOf - 1] === ' ')
          cscore += 0.8;
      }
      if(string[idxOf] === word[i])
        cscore += 0.1;
      rscore += cscore;
      startat = idxOf + 1;
    }
    score = 0.5 * (rscore / string.length + rscore / word.length);
    if(word.toLowerCase()[0] === string.toLowerCase()[0] && score < 0.85)
      score += 0.15;

    return {
      ...tmp,
      score: score
    };
  }).filter(t => t.score > 0).sort((a, b) => b.score - a.score);
};
