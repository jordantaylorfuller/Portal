(async () => {
  const [editorsRes, worksRes] = await Promise.all([
    fetch('/home/data/editors.json').then(r => r.json()),
    fetch('/home/data/works.json').then(r => r.json()),
  ]);
  const editors = editorsRes.items.sort((a, b) => a.order - b.order);
  const worksById = new Map(worksRes.items.map(w => [w.id, w]));

  const wrapper = document.querySelector('.editor-dropdown-wrapper.w-dyn-list');
  const list = wrapper && wrapper.querySelector('.editor-dropdown-list');
  const templateItem = list && list.querySelector('.w-dyn-item');
  const empty = wrapper && wrapper.querySelector('.w-dyn-empty');
  if (!wrapper || !list || !templateItem) return;

  const itemHtml = templateItem.outerHTML;
  list.innerHTML = '';

  for (const ed of editors) {
    const tmp = document.createElement('div');
    tmp.innerHTML = itemHtml;
    const item = tmp.firstElementChild;

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

  if (empty) empty.style.display = 'none';

  const totalEl = document.querySelector('.divflex-5 .text-11');
  if (totalEl && /TOTAL ENTRIES/.test(totalEl.textContent)) {
    totalEl.textContent = `TOTAL ENTRIES: ${editors.length}`;
  }

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
        other.classList.remove('w--open');
        const ot = other.querySelector('.w-dropdown-toggle');
        const op = other.querySelector('.w-dropdown-list');
        if (ot) { ot.classList.remove('w--open'); ot.setAttribute('aria-expanded', 'false'); }
        if (op) { op.classList.remove('w--open'); op.style.display = 'none'; }
      });
      dropdown.classList.toggle('w--open', willOpen);
      toggle.classList.toggle('w--open', willOpen);
      toggle.setAttribute('aria-expanded', String(willOpen));
      panel.classList.toggle('w--open', willOpen);
      panel.style.display = willOpen ? 'block' : 'none';
    });
  });

  document.dispatchEvent(new CustomEvent('cms:editors-ready'));
})();
