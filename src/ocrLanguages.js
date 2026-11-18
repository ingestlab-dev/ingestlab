// Language model codes from tessdata_fast 4.1.0; excludes osd and equ.
export const OCR_LANGUAGE_CODES = Object.freeze((
  'afr amh ara asm aze aze_cyrl bel ben bod bos bre bul cat ceb ces chi_sim chi_sim_vert chi_tra chi_tra_vert ' +
  'chr cos cym dan deu div dzo ell eng enm epo est eus fao fas fil fin fra frk frm fry gla gle glg grc guj hat ' +
  'heb hin hrv hun hye iku ind isl ita ita_old jav jpn jpn_vert kan kat kat_old kaz khm kir kmr kor kor_vert ' +
  'lao lat lav lit ltz mal mar mkd mlt mon mri msa mya nep nld nor oci ori pan pol por pus que ron rus san ' +
  'sin slk slv snd spa spa_old sqi srp srp_latn sun swa swe syr tam tat tel tgk tha tir ton tur uig ukr urd ' +
  'uzb uzb_cyrl vie yid yor'
).split(' '));

const FAST_MODEL_PATH = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0';
const supported = new Set(OCR_LANGUAGE_CODES);
export const OCR_DEFAULT_LANGS = 'vie+eng';

export function normalizeOcrLanguages(input = OCR_DEFAULT_LANGS) {
  const raw = typeof input === 'string' ? input.split('+') : input;
  if (!Array.isArray(raw) || !raw.length || !raw.every((s) =>
    typeof s === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(s.trim()))) {
    throw new TypeError('ocrLangs must contain model codes, for example "jpn+eng" or ["ara", "eng"]');
  }
  return [...new Set(raw.map((s) => s.trim()))].join('+');
}

export function resolveOcrModels(langs, runtime = {}) {
  const codes = langs.split('+');
  if (runtime.langPath) return { langPath: runtime.langPath, gzip: runtime.gzip ?? true };
  const unknown = codes.find((code) => !supported.has(code));
  if (unknown) throw new Error('Unknown OCR model "' + unknown + '"; set ocrRuntime.langPath for custom models');
  if (codes.every((code) => code === 'eng' || code === 'vie')) return { gzip: true };
  return { langPath: FAST_MODEL_PATH, gzip: false, pinned: true };
}
