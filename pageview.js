(function(){
  document.addEventListener('DOMContentLoaded', () => {
    console.log('pageview: DOMContentLoaded');
    const track = document.querySelector('.page-track');
    if(!track){ console.warn('pageview: .page-track not found'); return; }
    // dots for direct indexing (optional) and arrows for prev/next
    const dots = Array.from(document.querySelectorAll('.page-dots .dot[data-index]'));
    const prevBtn = document.querySelector('.page-dots .prev');
    const nextBtn = document.querySelector('.page-dots .next');
    const pageEls = Array.from(track.querySelectorAll('.page'));
    const pages = pageEls.length;
    let index = 0;
    let startX = 0;
    let currentX = 0;
    let dragging = false;
    const threshold = 80; // px

  function setIndex(i){
    index = Math.max(0, Math.min(pages-1, i));
    // hide all pages, show active
    pageEls.forEach((p, idx) => {
      p.classList.toggle('active', idx === index);
    });
    // update indexed dots if present
    if (dots && dots.length) dots.forEach(d=>d.classList.toggle('active', Number(d.dataset.index)===index));
    // update arrow disabled state
    if (prevBtn) prevBtn.disabled = (index === 0);
    if (nextBtn) nextBtn.disabled = (index === pages-1);
  }

  function onPointerDown(e){
    dragging = true;
    startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
  }
  function onPointerUp(e){
    if(!dragging) return;
    dragging = false;
    const endX = e.clientX || (e.changedTouches && e.changedTouches[0].clientX) || startX;
    const dx = endX - startX;
    if(Math.abs(dx) > threshold){
      if(dx < 0) setIndex(index + 1);
      else setIndex(index - 1);
    }
  }

  // pointer/touch events (simple start/end swipe)
  track.addEventListener('pointerdown', onPointerDown, {passive:true});
  track.addEventListener('pointerup', onPointerUp, {passive:true});
  track.addEventListener('touchstart', onPointerDown, {passive:true});
  track.addEventListener('touchend', onPointerUp, {passive:true});

  // indexed dots clickable (if present)
  if (dots && dots.length) dots.forEach(d=> d.addEventListener('click', ()=> setIndex(Number(d.dataset.index)) ));

  // arrow buttons
  if (prevBtn) prevBtn.addEventListener('click', ()=> setIndex(index - 1));
  if (nextBtn) nextBtn.addEventListener('click', ()=> setIndex(index + 1));

    // init
    setIndex(0);

    // expose for debugging
    window.__pageView = { setIndex };
  });
})();