(async () => {
  const wrapper = document.querySelector('.editor-dropdown-wrapper.w-dyn-list');
  const list = wrapper && wrapper.querySelector('.editor-dropdown-list');
  const empty = wrapper && wrapper.querySelector('.w-dyn-empty');
  if (!wrapper || !list) return;

  // Build-time pre-render path: scripts/build-cms-pages.mjs already populated
  // the list at deploy time, so skip the runtime fetch+inject step (which
  // would re-empty the list and cause a visible reflow). The poster refresh
  // and DOM wiring still run in both paths.
  const prerendered = list.dataset.cmsPrerendered === 'true';
  let editors;

  if (prerendered) {
    // Recover slug list from rendered DOM so the poster refresh can target it.
    editors = Array.from(list.querySelectorAll('.w-dyn-item'))
      .map(item => ({ slug: item.dataset.editorSlug, reelSlug: item.dataset.editorSlug }))
      .filter(e => e.slug);
    if (empty) empty.style.display = 'none';
  } else {
    // Runtime fallback (e.g., dev session that hasn't built yet, or build error).
    const [editorsRes, worksRes] = await Promise.all([
      fetch('/home/data/editors.json').then(r => r.json()),
      fetch('/home/data/works.json').then(r => r.json()),
    ]);
    editors = editorsRes.items.sort((a, b) => a.order - b.order);
    const worksById = new Map(worksRes.items.map(w => [w.id, w]));

    // Read row template from <template id="cms-editor-row"> (lifted out of the
    // list so build can replace the visible list wholesale without losing it).
    const templateEl = document.getElementById('cms-editor-row');
    if (!templateEl) return;
    const itemHtml = templateEl.innerHTML.trim();

    renderEditorsRuntime(list, editors, worksById, itemHtml);

    if (empty) empty.style.display = 'none';
    list.dataset.cmsPrerendered = 'true';
  }

  // Immediate poster swap from data-mux-playback-id. Every .vimeo-shell ships
  // with src="placeholder.svg" (the Webflow CMS placeholder), and the live
  // poster URL only gets stamped in by refreshPostersFromApi after a fetch
  // round-trip. That left the work cards showing a grey "image" icon for a
  // few seconds on first load. Mux thumbnails are deterministic from the
  // playback ID, so we construct the URL synchronously here and start the
  // image loads before the API call returns. The API call still runs after,
  // in case a poster has a custom time offset (admin-selected frame) or a
  // server override (e.g. NIPC logo fallback — commit 2a8de97).
  applyMuxPostersFromMarkup();

  // Runtime poster sync — DB is the single source of truth. Replace any baked
  // poster URLs that have changed since the last works.json regeneration.
  // We hold the promise (rather than fire-and-forget) so the auto-expand can
  // wait for it: the API returns posters with admin-selected `?time=X.Y`
  // offsets that differ from the default Mux thumbnail we set synchronously,
  // and opening the panel before that swap completes causes the work card
  // image to visibly flicker to the custom frame a second later.
  const postersReady = refreshPostersFromApi(editors).catch(err => {
    console.warn('poster refresh failed', err);
  });

  const totalEl = document.querySelector('.divflex-5 .text-11');
  if (totalEl && /TOTAL ENTRIES/.test(totalEl.textContent)) {
    totalEl.textContent = `TOTAL ENTRIES: ${editors.length}`;
  }

  wireDropdowns(list);
  wireEditorPreview(list);

  document.dispatchEvent(new CustomEvent('cms:editors-ready'));

  // Auto-expand a random editor on page load. Wait for:
  //   1) DOMContentLoaded — so the inline swiper script's initAll has run
  //      and the opened panel's slider measures correctly on first paint.
  //   2) refreshPostersFromApi — so admin-selected custom poster frames are
  //      already in place when the panel animates open (no visible flicker).
  // Both are capped by a max delay so a slow API can't strand the user on
  // an empty page indefinitely; if the timeout wins we fall back to the
  // default Mux thumbnails (which are already loaded by applyMuxPosters…).
  const MAX_WAIT_MS = 1500;
  const dcl = document.readyState === 'loading'
    ? new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }))
    : Promise.resolve();
  const cap = new Promise(r => setTimeout(r, MAX_WAIT_MS));
  Promise.race([Promise.all([dcl, postersReady]), cap]).then(() => {
    requestAnimationFrame(() => autoExpandRandomEditor(list));
  });

  // ── Helpers ──

  function renderEditorsRuntime(list, editors, worksById, itemHtml) {
    list.innerHTML = '';
    for (const ed of editors) {
      const tmp = document.createElement('div');
      tmp.innerHTML = itemHtml;
      const item = tmp.firstElementChild;
      if (ed.slug) item.dataset.editorSlug = ed.slug;
      if (ed.workPreviewLoopingGif) item.dataset.previewSrc = ed.workPreviewLoopingGif;

      const setText = (sel, value) => {
        const el = item.querySelector(sel);
        if (el) el.textContent = value || '';
      };
      const setBind = (sel, value) => {
        const el = item.querySelector(sel);
        if (!el) return;
        el.textContent = value || '';
        if (value) el.classList.remove('w-dyn-bind-empty');
      };

      const cells = item.querySelectorAll('.dropdown-toggle .text-13');
      if (cells[0]) cells[0].textContent = ed.numOnList || '';
      if (cells[1]) cells[1].textContent = ed.name || '';
      if (cells[2]) cells[2].textContent = ed.role || '';
      if (cells[3]) cells[3].textContent = ed.featureClients || '';
      setText('.dropdown-toggle .text-14', ed.yearRange || '');

      setBind('.sarah-chen-2', ed.name);
      setBind('.founder-editor-2', ed.role);
      setBind('.a-visual-exploration-of-athletic-transformation-through-abstract-motion-and-dynamic-typography-the-p', ed.bio);

      const workSlider = item.querySelector('.work_slider_cms_list');
      if (workSlider) {
        const workTemplate = workSlider.querySelector('.w-dyn-item');
        const workTemplateHtml = workTemplate && workTemplate.outerHTML;
        workSlider.innerHTML = '';
        const refs = (ed.referencingWork || []).map(id => worksById.get(id)).filter(Boolean);
        if (workTemplateHtml && refs.length) {
          for (const w of refs) {
            const wt = document.createElement('div');
            wt.innerHTML = workTemplateHtml;
            const wi = wt.firstElementChild;
            if (w.id) wi.dataset.assetId = w.id;
            const clientEls = wi.querySelectorAll('.client-agency');
            if (clientEls[0]) clientEls[0].textContent = w.client || '';
            if (clientEls[1]) clientEls[1].textContent = w.typeOfWork || '';
            const titleEl = wi.querySelector('.brand-film');
            if (titleEl) titleEl.textContent = w.name || '';
            const yearEl = wi.querySelector('._2024-2');
            if (yearEl) yearEl.textContent = w.year || '';
            const visitEl = wi.querySelector('a.visit-video');
            if (visitEl && w.visitLink) visitEl.href = w.visitLink;
            const posterImg = wi.querySelector('.vimeo-poster-img');
            if (posterImg && w.video && w.video.thumbnail) {
              posterImg.src = w.video.thumbnail;
              posterImg.alt = w.video.title || w.name;
            } else if (posterImg && w.thumbnailCover) {
              posterImg.src = w.thumbnailCover;
              posterImg.alt = w.name;
            }
            const vimeoUrl = wi.querySelector('.vimeo-url');
            if (vimeoUrl && w.video && w.video.url) vimeoUrl.textContent = w.video.url;
            const shell = wi.querySelector('.vimeo-shell');
            if (shell && w.video && w.video.playbackId) {
              shell.dataset.muxPlaybackId = w.video.playbackId;
            }
            workSlider.appendChild(wi);
          }
        }
      }

      if (ed.workPreviewLoopingGif) {
        const gif = item.querySelector('.works-loop-gif');
        if (gif) gif.style.backgroundImage = `url("${ed.workPreviewLoopingGif}")`;
      }

      list.appendChild(item);
    }
  }

  function wireDropdowns(list) {
    list.querySelectorAll('.w-dropdown').forEach(dropdown => {
      const toggle = dropdown.querySelector('.w-dropdown-toggle');
      const panel = dropdown.querySelector('.w-dropdown-list');
      if (!toggle || !panel) return;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.style.cursor = 'pointer';
      toggle.addEventListener('click', e => {
        e.preventDefault();
        const willOpen = !dropdown.classList.contains('w--open');
        list.querySelectorAll('.w-dropdown.w--open').forEach(other => {
          if (other === dropdown) return;
          const ot = other.querySelector('.w-dropdown-toggle');
          const op = other.querySelector('.w-dropdown-list');
          if (ot && op) setDropdownOpen(other, ot, op, false);
        });
        setDropdownOpen(dropdown, toggle, panel, willOpen);
      });
    });
  }

  function setDropdownOpen(dropdown, toggle, panel, open) {
    if (panel._dropdownEnd) {
      panel.removeEventListener('transitionend', panel._dropdownEnd);
      panel._dropdownEnd = null;
    }
    if (panel._dropdownResize) {
      panel._dropdownResize.disconnect();
      panel._dropdownResize = null;
    }
    if (open) {
      panel.style.display = 'block';
      const target = panel.scrollHeight;
      panel.style.height = '0px';
      panel.style.opacity = '0';
      void panel.offsetHeight;
      dropdown.classList.add('w--open');
      toggle.classList.add('w--open');
      panel.classList.add('w--open');
      toggle.setAttribute('aria-expanded', 'true');
      panel.style.height = target + 'px';
      panel.style.opacity = '1';
      // The inline swiper script runs swiper.update() ~150ms after the click,
      // and lazy-loaded poster images can resolve at any point during the
      // animation. Both grow the panel's natural height after we measured
      // scrollHeight, which on the FIRST open made the animation land on the
      // wrong (too short) target and snap up when the transition ended.
      // Watch the panel's content and re-target the inline height live —
      // CSS transitions are interruptible, so the in-flight animation just
      // continues smoothly to the new target.
      const content = panel.firstElementChild;
      if (content && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          if (!panel.classList.contains('w--open')) return;
          const next = panel.scrollHeight;
          if (Math.abs(parseFloat(panel.style.height) - next) > 0.5) {
            panel.style.height = next + 'px';
          }
        });
        ro.observe(content);
        panel._dropdownResize = ro;
      }
      panel._dropdownEnd = e => {
        if (e.target !== panel || e.propertyName !== 'height') return;
        panel.style.height = '';
        panel.removeEventListener('transitionend', panel._dropdownEnd);
        panel._dropdownEnd = null;
        // Keep observing briefly after the transition completes — swiper's
        // 150ms delayed update and late image loads can still arrive after
        // 360ms on slow networks. Disconnect once things settle.
        if (panel._dropdownResize) {
          setTimeout(() => {
            if (panel._dropdownResize) {
              panel._dropdownResize.disconnect();
              panel._dropdownResize = null;
            }
          }, 400);
        }
      };
      panel.addEventListener('transitionend', panel._dropdownEnd);
    } else {
      const wasOpen = dropdown.classList.contains('w--open');
      if (!wasOpen) {
        panel.style.display = 'none';
        panel.style.height = '';
        panel.style.opacity = '';
        return;
      }
      panel.style.height = panel.scrollHeight + 'px';
      void panel.offsetHeight;
      dropdown.classList.remove('w--open');
      toggle.classList.remove('w--open');
      panel.classList.remove('w--open');
      toggle.setAttribute('aria-expanded', 'false');
      panel.style.height = '0px';
      panel.style.opacity = '0';
      panel._dropdownEnd = e => {
        if (e.target !== panel || e.propertyName !== 'height') return;
        panel.style.display = 'none';
        panel.style.height = '';
        panel.style.opacity = '';
        panel.removeEventListener('transitionend', panel._dropdownEnd);
        panel._dropdownEnd = null;
      };
      panel.addEventListener('transitionend', panel._dropdownEnd);
    }
  }

  // Pick a random editor and animate it open on page load. sessionStorage
  // remembers the previous pick so consecutive visits within the same tab
  // never land on the same editor twice in a row. The expand uses the same
  // animated setDropdownOpen path as user clicks, so the user sees the row
  // ease open instead of a hard cut from all-closed to one-open.
  function autoExpandRandomEditor(list) {
    const items = list.querySelectorAll('.w-dyn-item');
    if (items.length < 1) return;
    const STORAGE_KEY = 'nipc_last_auto_editor';
    let lastSlug = '';
    try { lastSlug = sessionStorage.getItem(STORAGE_KEY) || ''; } catch (e) {}
    const all = Array.from(items);
    const candidates = all.filter(i => i.dataset.editorSlug && i.dataset.editorSlug !== lastSlug);
    const pool = candidates.length ? candidates : all;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    if (chosen.dataset.editorSlug) {
      try { sessionStorage.setItem(STORAGE_KEY, chosen.dataset.editorSlug); } catch (e) {}
    }
    const dropdown = chosen.querySelector('.editor-dropdown');
    if (!dropdown) return;
    const toggle = dropdown.querySelector('.w-dropdown-toggle');
    const panel = dropdown.querySelector('.w-dropdown-list');
    if (toggle && panel) setDropdownOpen(dropdown, toggle, panel, true);
  }

  // Floating cursor preview — fade in editor's looping work preview when their
  // row is hovered, follow the cursor, fade out on leave. Suppressed while the
  // row is open (the inline .works-loop-gif takes over there).
  function wireEditorPreview(list) {
    const box = document.querySelector('.preview-box');
    const img = box && box.querySelector('.preview-img');
    if (!box || !img) return;
    const items = list.querySelectorAll('.w-dyn-item');
    if (!items.length) return;

    let active = null;
    let pendingFrame = 0;
    let lastX = 0, lastY = 0;
    const OFFSET_X = 24;
    const OFFSET_Y = 24;

    function show(item) {
      const src = item.dataset.previewSrc;
      if (!src) return;
      if (item.querySelector('.editor-dropdown.w--open')) return;
      if (img.src !== src) img.src = src;
      active = item;
      box.classList.add('is-active');
    }
    function hide(item) {
      if (item && item !== active) return;
      active = null;
      box.classList.remove('is-active');
    }

    items.forEach(item => {
      const toggle = item.querySelector('.dropdown-toggle');
      if (!toggle) return;
      toggle.addEventListener('mouseenter', () => show(item));
      toggle.addEventListener('mouseleave', () => hide(item));
      toggle.addEventListener('click', () => {
        // The dropdown wiring's click listener ran first and synchronously
        // toggled the .w--open class. Hide the floating preview if the row
        // is now open (so it doesn't double up with the inline gif), or
        // show it again if the click closed the row and we're still hovering.
        if (item.querySelector('.editor-dropdown.w--open')) {
          hide(item);
        } else if (toggle.matches(':hover')) {
          show(item);
        }
      });
    });

    document.addEventListener('mousemove', e => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (!active) return;
      if (pendingFrame) return;
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = 0;
        const w = box.offsetWidth || 320;
        const h = box.offsetHeight || 180;
        const maxX = window.innerWidth - w - 8;
        const maxY = window.innerHeight - h - 8;
        const x = Math.max(8, Math.min(lastX + OFFSET_X, maxX));
        const y = Math.max(8, Math.min(lastY + OFFSET_Y, maxY));
        box.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      });
    });
  }

  function applyMuxPostersFromMarkup() {
    document.querySelectorAll('.vimeo-shell[data-mux-playback-id]').forEach(shell => {
      const playbackId = shell.dataset.muxPlaybackId;
      const img = shell.querySelector('.vimeo-poster-img');
      if (!playbackId || !img) return;
      // Only swap when the img is still on the Webflow placeholder. If a
      // build- or runtime-stamped poster is already in place (e.g. a custom
      // server override), don't overwrite it.
      if (!img.src || img.src.includes('placeholder')) {
        img.src = `https://image.mux.com/${playbackId}/thumbnail.jpg?width=640&height=360&fit_mode=preserve`;
      }
      // Lazy loading defers requests until near-viewport intersection, which
      // never triggers for images inside the display:none panels of closed
      // dropdowns. Switching to eager lets the browser fetch all posters up
      // front so they're cached when the user opens any row.
      if (img.loading === 'lazy') img.loading = 'eager';
    });
  }

  // Apply the admin's saved focal-point + zoom to a poster <img>. The
  // .vimeo-shell parent already has overflow:hidden + 16:9 aspect, and the
  // img already has object-fit:cover + width/height 100%, so panning via
  // object-position and zooming via a CSS scale (pivoted on the same focal
  // point) reproduces the framing that reel.html shows for the same asset.
  function applyPosterTransform(img, asset) {
    const fx = asset.poster_focal_x != null ? Number(asset.poster_focal_x) : 50;
    const fy = asset.poster_focal_y != null ? Number(asset.poster_focal_y) : 50;
    const z  = asset.poster_zoom    != null ? Number(asset.poster_zoom)    : 1;
    // Force object-fit:cover inline — the mobile media query swaps to `fill`,
    // which would stretch instead of crop and defeat the framing.
    img.style.objectFit = 'cover';
    img.style.objectPosition = fx + '% ' + fy + '%';
    if (z === 1) {
      img.style.transform = '';
      img.style.transformOrigin = '';
    } else {
      img.style.transformOrigin = fx + '% ' + fy + '%';
      img.style.transform = 'scale(' + z + ')';
    }
  }

  async function refreshPostersFromApi(editors) {
    const slugs = [...new Set(editors.map(e => e.reelSlug || e.slug).filter(Boolean))];
    await Promise.all(slugs.map(async slug => {
      let res;
      try { res = await fetch('/api/reels/public?s=' + encodeURIComponent(slug)); }
      catch { return; }
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (!data || !Array.isArray(data.assets)) return;
      for (const asset of data.assets) {
        if (!asset.id) continue;
        const wi = document.querySelector('[data-asset-id="' + asset.id + '"]');
        if (!wi) continue;
        const img = wi.querySelector('.vimeo-poster-img');
        if (!img) continue;
        if (asset.poster && img.src !== asset.poster) img.src = asset.poster;
        // Even when the poster URL hasn't changed (e.g. admin only tweaked
        // crop, not frame), the focal/zoom may have — always re-apply.
        applyPosterTransform(img, asset);
      }
    }));
  }
})();
