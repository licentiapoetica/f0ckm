(function() {
  const koepfe = window.f0ckKoepfe;
  if (!koepfe || !koepfe.length) return;

  let current = null;

  const pick = () => {
    if (koepfe.length === 1) return koepfe[0];
    let next;
    do { next = koepfe[~~(Math.random() * koepfe.length)]; } while (next === current && koepfe.length > 1);
    return next;
  };

  if (document.getElementById('koepfe-img')) return;

  const img = document.createElement('img');
  img.id = 'koepfe-img';
  img.alt = '';
  img.draggable = false;

  const show = (src) => {
    current = src;
    img.classList.remove('visible');
    img.onload = () => img.classList.add('visible');
    img.src = src;
  };


  document.body.prepend(img);
  show(pick());

  // Hide the image immediately when a new AJAX load starts to prevent it 
  // from being revealed while the page content is empty/churning.
  window.addEventListener('pjax:start', () => {
    img.classList.remove('visible');
  });

  // Change on AJAX navigation (next/prev/random/page change) but NOT infinite scroll
  document.addEventListener('f0ck:contentLoaded', (e) => {
    if (e.detail && e.detail.isInfinite) return;
    
    // Small delay to ensure the content layer is fully painted on top 
    // before we swap the background image, preventing 'pop-in' flickers.
    setTimeout(() => {
	    show(pick());
    }, 150);
  });
})();
