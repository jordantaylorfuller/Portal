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
console.log(`Generated ${count} pages: ${works.items.length} works, ${editors.items.length} editors`);
