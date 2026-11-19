import '/src/widget.js';
import { OCR_LANGUAGE_CODES } from '/src/ocrLanguages.js';

const dropzone = document.querySelector('ingest-dropzone');
const status = document.querySelector('#file-status');
const download = document.querySelector('#download');
const samples = [...document.querySelectorAll('[data-sample]')];
let markdown, name;
const picker = document.querySelector('#ocr-picker');
const selection = document.querySelector('#ocr-selection');
const search = document.querySelector('#ocr-search');
const list = document.querySelector('#ocr-options');
const defaults = ['vie', 'eng'];
const selected = new Set(defaults);
const available = new Set();
let localModels = false;
const names = new Intl.DisplayNames(['vi'], { type: 'language' });
const english = new Intl.DisplayNames(['en'], { type: 'language' });
const subtitles = {
  chi_sim: 'Ti\u1ebfng Trung (gi\u1ea3n th\u1ec3)', chi_tra: 'Ti\u1ebfng Trung (ph\u1ed3n th\u1ec3)',
  aze_cyrl: 'Azerbaijani (Cyrillic)', uzb_cyrl: 'Uzbek (Cyrillic)', srp_latn: 'Serbian (Latin)',
  ita_old: 'Italian (historical)', kat_old: 'Georgian (historical)', spa_old: 'Spanish (historical)',
};
const items = OCR_LANGUAGE_CODES.map((code) => {
  const root = code.replace(/_vert$/, '');
  const label = (subtitles[root] || names.of(root)) + (code.endsWith('_vert') ? ' (vi\u1ebft d\u1ecdc)' : '');
  const option = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.value = code;
  option.append(input, document.createTextNode(label + ' (' + code + ')'));
  return { code, option, input, label, query: [label, code, english.of(root.split('_')[0])].join(' ') };
}).sort((a, b) => a.label.localeCompare(b.label, 'vi'));
for (const { option } of items) list.append(option);
const searchable = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replaceAll('\u0111', 'd');
function refreshOcr() {
  const defaultsOnly = selected.size === 2 && defaults.every((code) => selected.has(code));
  const usesLocal = [...selected].every((code) => defaults.includes(code));
  if (usesLocal && localModels) dropzone.setAttribute('ocr-lang-src', '/ocr-lang');
  else dropzone.removeAttribute('ocr-lang-src');
  if (selected.size) dropzone.setAttribute('ocr-langs', [...selected].join('+'));
  else dropzone.removeAttribute('ocr-langs');
  selection.textContent = defaultsOnly || !selected.size ? 'Vi\u1ec7t + Anh' : [...selected].join(' + ');
  for (const { input, option, code, query } of items) {
    input.checked = selected.has(code);
    option.hidden = !searchable(query).includes(searchable(search.value.trim()));
  }
}
search.addEventListener('input', refreshOcr);
list.addEventListener('change', ({ target }) => {
  if (target.checked) selected.add(target.value);
  else selected.delete(target.value);
  refreshOcr();
});
document.querySelector('#ocr-reset').addEventListener('click', () => {
  selected.clear();
  for (const code of defaults) selected.add(code);
  search.value = '';
  refreshOcr();
  search.focus();
});
picker.addEventListener('toggle', () => { if (picker.open) search.focus(); });
refreshOcr();
Promise.all(defaults.map((code) => fetch('/ocr-lang/' + code + '.traineddata', { method: 'HEAD' })))
  .then((responses) => {
    localModels = responses.every((response) => response.ok);
    refreshOcr();
  }).catch(() => {});

dropzone.addEventListener('ingest-progress', () => {
  download.disabled = true;
  status.textContent = '\u0110ang x\u1eed l\u00fd t\u1ec7p';
});
dropzone.addEventListener('ingest-result', ({ detail }) => {
  markdown = detail.markdown;
  download.disabled = !markdown;
  status.textContent = detail.stats ? `${detail.stats.pages} trang \u00b7 ${detail.stats.figures} h\u00ecnh\u002fbi\u1ec3u \u0111\u1ed3` :
    detail.kind === 'video' ? `${detail.keyframes.length} khung \u00b7 ${detail.scenesRepresented}/${detail.scenes.length} c\u1ea3nh` :
      `${detail.width} \u00d7 ${detail.height} \u00b7 ${detail.metrics.outputBytes.toLocaleString()} B`;
});
dropzone.addEventListener('ingest-error', () => {
  download.disabled = true;
  status.textContent = 'Kh\u00f4ng chuy\u1ec3n \u0111\u01b0\u1ee3c t\u1ec7p';
});
download.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name || 'ingestlab.md';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

for (const button of samples) {
  fetch('/sample/' + button.dataset.sample, { method: 'HEAD' })
    .then((response) => {
      if (response.ok) { available.add(button); button.disabled = false; }
    }).catch(() => {});
  button.addEventListener('click', async () => {
    for (const item of samples) item.disabled = true;
    download.disabled = true;
    status.textContent = '\u0110ang m\u1edf t\u1ec7p m\u1eabu';
    const id = button.dataset.sample;
    try {
      const response = await fetch('/sample/' + id);
      if (!response.ok) throw new Error('Sample unavailable');
      const filename = response.headers.get('X-Sample-Filename');
      name = filename ? decodeURIComponent(filename).replace(/\.pdf$/i, '.md') : 'ingestlab-sample-' + id + '.md';
      if (button.dataset.ocrLang) dropzone.setAttribute('ocr-langs', button.dataset.ocrLang);
      await dropzone.ingestFile(new File([await response.blob()], name.replace(/\.md$/, '.pdf'), {
        type: 'application/pdf',
      }));
    } catch {
      status.textContent = 'Kh\u00f4ng m\u1edf \u0111\u01b0\u1ee3c t\u1ec7p m\u1eabu';
    } finally {
      refreshOcr();
      for (const item of available) item.disabled = false;
    }
  });
}

dropzone.shadowRoot.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) name = file.name.replace(/\.pdf$/i, '') + '.md';
}, { capture: true });
dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) name = file.name.replace(/\.pdf$/i, '') + '.md';
}, { capture: true });
