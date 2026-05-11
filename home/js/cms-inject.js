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

  // Runtime poster sync — DB is the single source of truth. Replace any baked
  // poster URLs that have changed since the last works.json regeneration.
  refreshPostersFromApi(editors).catch(err => console.warn('poster refresh failed', err));

  const totalEl = document.querySelector('.divflex-5 .text-11');
  if (totalEl && /TOTAL ENTRIES/.test(totalEl.textContent)) {
    totalEl.textContent = `TOTAL ENTRIES: ${editors.length}`;
  }

  wireDropdowns(list);
  wireEditorPreview(list);

  document.dispatchEvent(new CustomEvent('cms:editors-ready'));

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
      panel._dropdownEnd = e => {
        if (e.target !== panel || e.propertyName !== 'height') return;
        panel.style.height = '';
        panel.removeEventListener('transitionend', panel._dropdownEnd);
        panel._dropdownEnd = null;
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
        if (!asset.id || !asset.poster) continue;
        const wi = document.querySelector('[data-asset-id="' + asset.id + '"]');
        if (!wi) continue;
        const img = wi.querySelector('.vimeo-poster-img');
        if (img && img.src !== asset.poster) img.src = asset.poster;
      }
    }));
  }
})();
