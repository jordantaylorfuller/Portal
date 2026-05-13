// Runtime canonical-poster overlay for surfaces that aren't scoped to one
// reel: static editor pages, work detail pages, and reel.html category mode.
//
// Each poster slot ships with a default Mux thumbnail baked into the HTML so
// first paint always shows *something*. This script collects every
// [data-mux-playback-id] on the page, batches a single /api/posters call, and
// swaps in the admin-curated poster + crop transform. Idempotent — safe to
// re-run after dynamic content insertion.

(function () {
  const SELECTOR = '[data-mux-playback-id]';

  async function syncOnce(root) {
    const scope = root || document;
    const els = scope.querySelectorAll(SELECTOR);
    if (!els.length) return;

    // De-dup playback IDs so a page with three thumbs of the same video only
    // sends one ID to the API.
    const ids = [...new Set([...els].map(el => el.dataset.muxPlaybackId).filter(Boolean))];
    if (!ids.length) return;

    let posters;
    try {
      const res = await fetch('/api/posters?ids=' + encodeURIComponent(ids.join(',')));
      if (!res.ok) return;
      const data = await res.json();
      posters = data.posters || {};
    } catch (e) {
      return;
    }

    els.forEach(el => {
      const pid = el.dataset.muxPlaybackId;
      const p = posters[pid];
      if (!p) return;
      applyPoster(el, p);
    });
  }

  // Apply poster URL + crop to one element. Handles both shapes used across
  // the site: <img class="vimeo-poster-img"> nested in a clipping shell, and
  // a <div> with background-image:url(...) (editor thumb, work hero).
  function applyPoster(el, poster) {
    const fx = Number(poster.poster_focal_x ?? 50);
    const fy = Number(poster.poster_focal_y ?? 50);
    const z  = Number(poster.poster_zoom    ?? 1);

    const img = el.querySelector('img.vimeo-poster-img, img[data-poster-img]');
    if (img) {
      if (poster.poster) img.src = poster.poster;
      img.style.objectFit = 'cover';
      img.style.objectPosition = fx + '% ' + fy + '%';
      img.style.transformOrigin = fx + '% ' + fy + '%';
      img.style.transform = z === 1 ? '' : 'scale(' + z + ')';
      return;
    }

    // Background-image path — used by the static editor grid (.thumb) and the
    // work-detail hero (.video-frame). Match reel.html applyPosterCropToEl:
    // pan via background-position; zoom by oversizing background-size on both
    // axes (works because both source and frame are 16:9, so uniform scaling
    // is identical to a transform: scale and stays inside the box).
    if (poster.poster) {
      el.style.backgroundImage = 'url(' + JSON.stringify(poster.poster) + ')';
    }
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundSize = z === 1 ? 'cover' : ((100 * z).toFixed(2) + '% ' + (100 * z).toFixed(2) + '%');
    el.style.backgroundPosition = fx + '% ' + fy + '%';
  }

  // Run once on DOMContentLoaded, then expose for callers (e.g. reel.html
  // category mode) that build markup at runtime and need to re-sync.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => syncOnce(), { once: true });
  } else {
    syncOnce();
  }
  window.posterSync = syncOnce;
})();
