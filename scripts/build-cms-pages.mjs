#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'home/data');
const WORKS_OUT = join(ROOT, 'works');
const EDITORS_OUT = join(ROOT, 'editors');

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const layout = ({ title, description, body }) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)}</title>
  <meta name="description" content="${escape(description)}">
  <meta property="og:title" content="${escape(title)}">
  <meta property="og:description" content="${escape(description)}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/home/images/nipc-favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/home/images/favicon.png" type="image/png" sizes="32x32">
  <link rel="apple-touch-icon" href="/home/images/webclip.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap">
  <link rel="stylesheet" href="/home/css/normalize.css">
  <link rel="stylesheet" href="/home/css/webflow.css">
  <link rel="stylesheet" href="/home/css/nipc.webflow.css">
  <style>
    body { font-family: 'DM Mono', monospace; background: #1a1818; color: #e9e6e2; margin: 0; padding: 48px 64px; min-height: 100vh; }
    a { color: #dc2828; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .crumb { font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.7; margin-bottom: 48px; }
    .detail-title { font-family: 'Instrument Serif', serif; font-size: 96px; line-height: 1; margin: 0 0 16px; font-weight: 400; color: #e9e6e2; }
    .detail-meta { display: grid; grid-template-columns: 120px 1fr; gap: 8px 32px; max-width: 720px; font-size: 12px; line-height: 1.6; margin-top: 32px; }
    .detail-meta dt { opacity: 0.5; text-transform: uppercase; letter-spacing: 0.04em; }
    .detail-meta dd { margin: 0; }
    .bio { max-width: 720px; margin-top: 48px; font-size: 14px; line-height: 1.6; opacity: 0.85; }
    .video-frame { position: relative; width: 100%; max-width: 1200px; aspect-ratio: 16/9; margin: 64px 0; background: #000; }
    .video-frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 32px; margin-top: 48px; }
    .card { display: block; color: inherit; }
    .card .thumb { aspect-ratio: 16/9; background: #2a2424 center/cover no-repeat; margin-bottom: 8px; }
    .card .title { font-size: 13px; font-weight: 500; margin-bottom: 4px; }
    .card .meta { font-size: 11px; opacity: 0.6; }
    .section-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; margin: 64px 0 16px; }
  </style>
</head>
<body>
  <nav class="crumb"><a href="/home">← NIPC HOME</a></nav>
  ${body}
</body>
</html>
`;

const buildWork = (work, editorsById) => {
  const credits = (work.referenceEditors || []).map(id => editorsById.get(id)).filter(Boolean);
  const vimeoId = (() => {
    const u = work.video?.url || work.visitLink;
    const m = String(u || '').match(/vimeo\.com\/(?:.*\/)?(\d+)(?:\b|\/|\?)/);
    return m ? m[1] : null;
  })();
  const embed = vimeoId
    ? `<div class="video-frame"><iframe src="https://player.vimeo.com/video/${vimeoId}?title=0&byline=0&portrait=0&dnt=1" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>`
    : (work.thumbnailCover ? `<div class="video-frame" style="background:url(${escape(work.thumbnailCover)}) center/cover"></div>` : '');
  const visitLink = work.visitLink
    ? `<dt>VISIT</dt><dd><a href="${escape(work.visitLink)}" target="_blank" rel="noopener">${escape(work.visitLink)} ↗</a></dd>`
    : '';
  const creditList = credits.length
    ? `<div class="section-label">Edited by</div>
       <div class="grid">
         ${credits.map(ed => `
           <a class="card" href="/editors/${escape(ed.slug)}">
             ${ed.workPreviewLoopingGif ? `<div class="thumb" style="background-image:url(${escape(ed.workPreviewLoopingGif)})"></div>` : '<div class="thumb"></div>'}
             <div class="title">${escape(ed.name)}</div>
             <div class="meta">${escape(ed.role)} · ${escape(ed.featureClients || '')}</div>
           </a>
         `).join('')}
       </div>`
    : '';
  const desc = work.video?.description
    ? `<p class="bio">${escape(work.video.description)}</p>`
    : '';
  return layout({
    title: `${work.name} | NIPC`,
    description: work.video?.description || `${work.typeOfWork} for ${work.client}, ${work.year}.`,
    body: `
      <h1 class="detail-title">${escape(work.name)}</h1>
      <dl class="detail-meta">
        <dt>CLIENT</dt><dd>${escape(work.client)}</dd>
        <dt>TYPE</dt><dd>${escape(work.typeOfWork)}</dd>
        <dt>YEAR</dt><dd>${escape(work.year)}</dd>
        ${visitLink}
      </dl>
      ${embed}
      ${desc}
      ${creditList}
    `,
  });
};

const buildEditor = (editor, worksById) => {
  const works = (editor.referencingWork || []).map(id => worksById.get(id)).filter(Boolean);
  const workCards = works.length
    ? `<div class="section-label">Selected Works</div>
       <div class="grid">
         ${works.map(w => `
           <a class="card" href="/works/${escape(w.slug)}">
             ${w.thumbnailCover ? `<div class="thumb" style="background-image:url(${escape(w.thumbnailCover)})"></div>` : '<div class="thumb"></div>'}
             <div class="title">${escape(w.name)}</div>
             <div class="meta">${escape(w.client)} · ${escape(w.year)} · ${escape(w.typeOfWork)}</div>
           </a>
         `).join('')}
       </div>`
    : '';
  const bio = editor.bio
    ? `<p class="bio">${escape(editor.bio)}</p>`
    : '';
  return layout({
    title: `${editor.name} | NIPC Editor`,
    description: editor.bio || `${editor.role} at NIPC. Clients include ${editor.featureClients || ''}.`,
    body: `
      <h1 class="detail-title">${escape(editor.name)}</h1>
      <dl class="detail-meta">
        <dt>ROLE</dt><dd>${escape(editor.role)}</dd>
        <dt>CLIENTS</dt><dd>${escape(editor.featureClients || '')}</dd>
        <dt>YEARS</dt><dd>${escape(editor.yearRange || '')}</dd>
      </dl>
      ${bio}
      ${workCards}
    `,
  });
};

const editors = JSON.parse(await readFile(join(DATA_DIR, 'editors.json'), 'utf8'));
const works = JSON.parse(await readFile(join(DATA_DIR, 'works.json'), 'utf8'));
const editorsById = new Map(editors.items.map(e => [e.id, e]));
const worksById = new Map(works.items.map(w => [w.id, w]));

await mkdir(WORKS_OUT, { recursive: true });
await mkdir(EDITORS_OUT, { recursive: true });

let count = 0;
for (const w of works.items) {
  await writeFile(join(WORKS_OUT, `${w.slug}.html`), buildWork(w, editorsById));
  count++;
}
for (const e of editors.items) {
  await writeFile(join(EDITORS_OUT, `${e.slug}.html`), buildEditor(e, worksById));
  count++;
}

// Pre-render editor rows into home/index.html so the page paints with content
// already present, instead of: empty template row → cleared list → injected
// rows. Mirrors the runtime behavior in home/js/cms-inject.js, which checks
// data-cms-prerendered and skips its inject step when this build has run.
const HOME_PATH = join(ROOT, 'home/index.html');
const homeHtml = await readFile(HOME_PATH, 'utf8');

const sortedEditors = [...editors.items].sort((a, b) => a.order - b.order);
const renderedRows = renderEditorListHtml(homeHtml, sortedEditors, worksById);
const newHomeHtml = injectEditorList(homeHtml, renderedRows, sortedEditors.length);
if (newHomeHtml !== homeHtml) {
  await writeFile(HOME_PATH, newHomeHtml);
  count++;
}

console.log(`Generated ${count} pages: ${works.items.length} works, ${editors.items.length} editors, home/index.html`);

// ── Editor list pre-render helpers ──
// String-templating mirrors of home/js/cms-inject.js. They keep the runtime
// markup and the build-time markup byte-identical, which is what lets the
// page work correctly whether the user lands on a freshly-built deploy or
// a dev session that has not yet built.

function getTemplateHtml(homeHtml) {
  const m = homeHtml.match(/<template id="cms-editor-row">([\s\S]*?)<\/template>/);
  if (!m) throw new Error('cms-editor-row template not found in home/index.html');
  return m[1].trim();
}

function setAttr(html, sel, attr, value) {
  // Add an attribute to the first element matching `sel` (`tag.class` form).
  const [tag, cls] = sel.split('.');
  const re = new RegExp(`<${tag}\\b([^>]*\\bclass="[^"]*\\b${cls}\\b[^"]*"[^>]*)>`);
  return html.replace(re, (_, attrs) => `<${tag}${attrs} ${attr}="${escape(value)}">`);
}

function setTextByClass(html, cls, value) {
  // Replace inner text of the first element with class `cls` (any tag).
  const re = new RegExp(`(<([a-zA-Z]+)\\b[^>]*\\bclass="[^"]*\\b${escapeRegex(cls)}\\b[^"]*"[^>]*>)([\\s\\S]*?)(</\\2>)`);
  return html.replace(re, (_, open, _tag, _inner, close) => `${open}${escape(value || '')}${close}`);
}

function setBindByClass(html, cls, value) {
  // Like setTextByClass, but also strip the w-dyn-bind-empty marker when value is non-empty.
  const re = new RegExp(`(<([a-zA-Z]+)\\b[^>]*\\bclass=")([^"]*\\b${escapeRegex(cls)}\\b[^"]*)("[^>]*>)([\\s\\S]*?)(</\\2>)`);
  return html.replace(re, (_, openLead, _tag, classes, openTail, _inner, close) => {
    const newClasses = value ? classes.replace(/\s*\bw-dyn-bind-empty\b/, '') : classes;
    return `${openLead}${newClasses}${openTail}${escape(value || '')}${close}`;
  });
}

function setHrefByClass(html, cls, value) {
  // Find the <a class="...cls..."> tag (either attribute order), then rewrite
  // its href in-place. The previous single-regex required class to come
  // before href in source order; Webflow's exports put href first, so the
  // match silently failed and every visit-video link stayed as `#`.
  const tagRe = new RegExp(`<a\\b[^>]*\\bclass="[^"]*\\b${escapeRegex(cls)}\\b[^"]*"[^>]*>`);
  return html.replace(tagRe, (tag) => tag.replace(/\bhref="[^"]*"/, `href="${escape(value)}"`));
}

function setImgSrcByClass(html, cls, src, alt) {
  const re = new RegExp(`(<img\\b[^>]*\\bclass="[^"]*\\b${escapeRegex(cls)}\\b[^"]*"[^>]*\\bsrc=")([^"]*)("[^>]*\\balt=")([^"]*)(")`);
  return html.replace(re, (_, leadSrc, _src, midAlt, _alt, tail) => `${leadSrc}${escape(src)}${midAlt}${escape(alt || '')}${tail}`);
}

function setStyleByClass(html, cls, prop, value) {
  // Append `prop:value;` to the first element with `cls`. Replace existing style if present.
  const reStyle = new RegExp(`(<[a-zA-Z]+\\b[^>]*\\bclass="[^"]*\\b${escapeRegex(cls)}\\b[^"]*"[^>]*\\bstyle=")([^"]*)(")`);
  if (reStyle.test(html)) {
    return html.replace(reStyle, (_, lead, existing, tail) => `${lead}${existing}${prop}:${escape(value)};${tail}`);
  }
  const reNoStyle = new RegExp(`(<[a-zA-Z]+\\b[^>]*\\bclass="[^"]*\\b${escapeRegex(cls)}\\b[^"]*")([^>]*>)`);
  return html.replace(reNoStyle, (_, lead, tail) => `${lead} style="${prop}:${escape(value)};"${tail}`);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderWorkSlide(template, work) {
  let html = template;
  // The slide template has two .client-agency spots (top and bottom).
  // Replace them in order: first occurrence = client, second = typeOfWork.
  let firstReplaced = false;
  html = html.replace(/(<p\b[^>]*\bclass="[^"]*\bclient-agency\b[^"]*"[^>]*>)([\s\S]*?)(<\/p>)/g, (_, open, _inner, close) => {
    const value = firstReplaced ? work.typeOfWork : work.client;
    firstReplaced = true;
    return `${open}${escape(value || '')}${close}`;
  });
  html = setTextByClass(html, 'brand-film', work.name || '');
  html = setTextByClass(html, '_2024-2', work.year || '');
  if (work.visitLink) html = setHrefByClass(html, 'visit-video', work.visitLink);
  const posterSrc = work.video?.thumbnail || work.thumbnailCover || '';
  if (posterSrc) {
    const alt = work.video?.title || work.name || '';
    html = setImgSrcByClass(html, 'vimeo-poster-img', posterSrc, alt);
  }
  if (work.video?.url) {
    html = html.replace(/(<div\b[^>]*\bclass="vimeo-url"[^>]*>)([\s\S]*?)(<\/div>)/, (_, open, _inner, close) => `${open}${escape(work.video.url)}${close}`);
  }
  if (work.id) {
    html = html.replace(/<div\b([^>]*)\bclass="(work_slider_cms_item[^"]*)"([^>]*)>/, (_, before, classes, after) => `<div${before} class="${classes}"${after} data-asset-id="${escape(work.id)}">`);
  }
  if (work.video?.playbackId) {
    html = html.replace(/<div\b([^>]*)\bclass="([^"]*\bvimeo-shell\b[^"]*)"([^>]*)>/, (_, before, classes, after) => `<div${before} class="${classes}"${after} data-mux-playback-id="${escape(work.video.playbackId)}">`);
  }
  return html;
}

function renderEditorRow(template, ed, worksById) {
  let html = template;

  // Slug + preview src as data-attrs on the row.
  if (ed.slug || ed.workPreviewLoopingGif) {
    html = html.replace(/^(\s*)<div\b([^>]*)\bclass="w-dyn-item"([^>]*)>/, (_, ws, before, after) => {
      const attrs = [];
      if (ed.slug) attrs.push(`data-editor-slug="${escape(ed.slug)}"`);
      if (ed.workPreviewLoopingGif) attrs.push(`data-preview-src="${escape(ed.workPreviewLoopingGif)}"`);
      return `${ws}<div${before} class="w-dyn-item"${after} ${attrs.join(' ')}>`;
    });
  }

  // The editor toggle has 4 .text-13 cells: number, name, role, featureClients.
  const toggleCells = [ed.numOnList, ed.name, ed.role, ed.featureClients];
  let cellIdx = 0;
  // Match only .text-13 in the dropdown-toggle row (before the dropdown-list nav).
  const toggleEnd = html.indexOf('<nav class="dropdown-list w-dropdown-list">');
  if (toggleEnd === -1) throw new Error('dropdown-list nav not found in editor template');
  const toggleHtml = html.slice(0, toggleEnd);
  const restHtml = html.slice(toggleEnd);
  const newToggleHtml = toggleHtml.replace(/(<div\b[^>]*\bclass="text-13"[^>]*>)([\s\S]*?)(<\/div>)/g, (_, open, _inner, close) => {
    const v = toggleCells[cellIdx++];
    return `${open}${escape(v || '')}${close}`;
  });
  const yearReplacedToggle = newToggleHtml.replace(/(<div\b[^>]*\bclass="text-14"[^>]*>)([\s\S]*?)(<\/div>)/, (_, open, _inner, close) => `${open}${escape(ed.yearRange || '')}${close}`);
  html = yearReplacedToggle + restHtml;

  // Bio panel fields.
  html = setBindByClass(html, 'sarah-chen-2', ed.name);
  html = setBindByClass(html, 'founder-editor-2', ed.role);
  html = setBindByClass(html, 'a-visual-exploration-of-athletic-transformation-through-abstract-motion-and-dynamic-typography-the-p', ed.bio);

  // Inner work slider — extract the single slide template inside
  // .work_slider_cms_list, then replace the list's children with one rendered
  // slide per referenced work. The match is anchored on the `.drag-indicator`
  // sibling so we capture the FULL slide (which contains multiple inner
  // </div></div> pairs around .vimeo-url + .vimeo-shell) instead of stopping
  // at the first balanced-looking pair and leaving the slide unclosed. An
  // unclosed slide makes every subsequent slide get nested inside the previous
  // one, which breaks Swiper layout and tanks the video aspect ratio.
  // The template's tail is `</slide></list></wrap><drag-indicator>`, so the
  // sentinel needs *two* </div> before the drag-indicator: one for list close
  // and one for wrap close. That makes the non-greedy capture stop right
  // after </slide>, so each rendered slide includes only its own closing
  // tag instead of also dragging the list-close along (which would make
  // every slide after the first a sibling of the list, not a child).
  const sliderRe = /(<div\b[^>]*\bclass="work_slider_cms_list[^"]*"[^>]*>)([\s\S]*?)(<\/div>\s*<\/div>\s*<div\b[^>]*\bclass="drag-indicator)/;
  const sliderMatch = html.match(sliderRe);
  if (sliderMatch) {
    const slideTemplate = sliderMatch[2].trim();
    const refs = (ed.referencingWork || []).map(id => worksById.get(id)).filter(Boolean);
    const slidesHtml = refs.length
      ? refs.map(w => renderWorkSlide(slideTemplate, w)).join('\n')
      : '';
    html = html.replace(sliderRe, (_, open, _inner, sentinel) => `${open}${slidesHtml}${sentinel}`);
  }

  if (ed.workPreviewLoopingGif) {
    html = setStyleByClass(html, 'works-loop-gif', 'background-image', `url("${ed.workPreviewLoopingGif}")`);
  }

  return html;
}

function renderEditorListHtml(homeHtml, editors, worksById) {
  const template = getTemplateHtml(homeHtml);
  return editors.map(ed => renderEditorRow(template, ed, worksById)).join('\n              ');
}

function injectEditorList(homeHtml, renderedRows, totalEntries) {
  // Replace marker zone contents with rendered rows.
  const startMarker = '<!-- @cms:editors:start -->';
  const endMarker = '<!-- @cms:editors:end -->';
  const i = homeHtml.indexOf(startMarker);
  const j = homeHtml.indexOf(endMarker);
  if (i === -1 || j === -1 || j < i) throw new Error('cms editor markers not found in home/index.html');
  const before = homeHtml.slice(0, i + startMarker.length);
  const after = homeHtml.slice(j);
  let next = `${before}\n              ${renderedRows}\n              ${after}`;
  // Stamp data-cms-prerendered on the list so cms-inject.js skips runtime
  // injection. Strip any pre-existing copy first so re-running the build is
  // idempotent (same input → byte-identical output).
  next = next.replace(/(<div\b[^>]*\bclass="editor-dropdown-list w-dyn-items"[^>]*?)\s*data-cms-prerendered="true"/g, '$1');
  next = next.replace(/<div\b([^>]*)\bclass="editor-dropdown-list w-dyn-items"([^>]*)>/, (_, lead, tail) => `<div${lead.replace(/\s+$/, '')} class="editor-dropdown-list w-dyn-items"${tail.replace(/\s+$/, '')} data-cms-prerendered="true">`);
  // Update TOTAL ENTRIES count.
  next = next.replace(/(<div\b[^>]*\bclass="text-11"[^>]*>)TOTAL ENTRIES:[^<]*(<\/div>)/, `$1TOTAL ENTRIES: ${totalEntries}$2`);
  return next;
}
