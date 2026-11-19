import assert from 'node:assert/strict';
import { readTaggedForm } from '../src/taggedForm.js';
import { emitBlocks } from '../src/markdown.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IngestLab } from '../src/index.js';
import { renderMarkdown } from '../src/widget.js';
import { renderControls } from '../src/semantic.js';

const dir = process.env.INGESTLAB_PDF_DIR || fileURLToPath(new URL('../../pdf', import.meta.url));
if (!existsSync(dir)) {
  console.log('PDF corpus fixtures absent; skipping corpus regressions');
  process.exit(0);
}
const names = readdirSync(dir);
const lab = await IngestLab.init();
const parse = (name) => lab.parse(readFileSync(join(dir, name)), {
  semanticHtml: true, imageMode: 'none', ocr: false, cache: false,
});
const tables = (page) => page.filter((block) => block.type === 'table');
const schedules = await parse('Form 1040 Schedules 1, D and Side-by-Side Tax Tables.pdf');
const [schedule1, scheduleD, leftTax, rightTax] = tables(schedules.pages[0]);
assert.equal(schedules.stats.tables, 4);
const scheduleAnchors = ['SCHEDULE 1 (Form 1040)', 'SCHEDULE D (Form 1040)',
  'SIDE-BY-SIDE SEMI-RULED TABLES', '| 1,000 | 1,025 |', '| 14,000 | 14,050 |'];
let previousAnchor = -1;
for (const anchor of scheduleAnchors) {
  const index = schedules.markdown.indexOf(anchor);
  assert.ok(index > previousAnchor, 'Unexpected position for ' + anchor);
  previousAnchor = index;
}
assert.deepEqual(schedule1.rows[0], ['Line', 'Part I \u2014 Additional Income', 'Box', 'Amount ($)']);
assert.deepEqual(scheduleD.rows.slice(2).map((row) => row.slice(1)), Array.from({ length: 4 }, () => ['', '', '', '']));
assert.equal(scheduleD.meta.headerRows, 2);
assert.deepEqual(leftTax.rows.slice(2), [
  ['1,000', '', '', '', '', ''],
  ['1,000', '1,025', '101', '101', '101', '101'],
  ['1,025', '1,050', '104', '104', '104', '104'],
  ['1,050', '1,075', '106', '106', '106', '106'],
  ['2,000', '', '', '', '', ''],
  ['2,000', '2,025', '201', '201', '201', '201'],
  ['2,025', '2,050', '204', '204', '204', '204'],
]);
assert.deepEqual(rightTax.rows.slice(2), [
  ['14,000', '', '', '', '', ''],
  ['14,000', '14,050', '1,445', '1,403', '1,445', '1,403'],
  ['14,050', '14,100', '1,451', '1,408', '1,451', '1,408'],
  ['14,100', '14,150', '1,457', '1,413', '1,457', '1,413'],
  ['15,000', '', '', '', '', ''],
  ['15,000', '15,050', '1,565', '1,503', '1,565', '1,503'],
  ['15,050', '15,100', '1,571', '1,508', '1,571', '1,508'],
]);

const amended = await parse('Form 1040-X (2025) - 3-Column Comparative Return.pdf');
assert.deepEqual(amended.pages.map((page) => tables(page).length), [2, 3]);
const comparative = [tables(amended.pages[0])[1], tables(amended.pages[1])[0]];
for (const grid of comparative) {
  assert.deepEqual(grid.rows[1].slice(2), ['A. Original amount', 'B. Net change + or (-)', 'C. Correct amount']);
  assert.ok(grid.rows.slice(2).every((row) => row.length === 5 && row.slice(2).every((cell) => cell === '')));
}
assert.deepEqual(comparative.flatMap((grid) => grid.rows.slice(2).map((row) => row[0])).filter((s) => /^\d/.test(s)),
  ['1', '2', '3', '4a', '5', '6', '7', '8', '10', '11', '12', '13', '14\u201315', '16', '17', '18', '20', '22']);
assert.deepEqual(tables(amended.pages[1])[2].rows.slice(1), [[''], [''], ['']]);

const master = await parse('Form 1040 (2025) - Clean Master Test Fixture.pdf');
assert.deepEqual(master.pages.map((page) => tables(page).length), [4, 3, 2]);
assert.deepEqual(tables(master.pages[0])[3].rows[0], ['Section', 'Dependent Field', 'Dependent 1', 'Dependent 2', 'Dependent 3', 'Dependent 4']);
assert.deepEqual(tables(master.pages[1])[1].rows[0], ['Section', 'Line', 'Income Description', 'Box', 'Amount ($)']);
assert.match(master.markdown, /\| Last name \| Your social security number \|/);
assert.match(master.markdown, /\[ \] Checking \[ \] Savings/);
assert.doesNotMatch(master.markdown, /\[x\]|_{3,}/i);
assert.equal(master.stats.figures, 0);
for (const { markdown, stats } of [schedules, amended, master]) {
  assert.equal((renderMarkdown(markdown, [], { allowRawHtml: false }).match(/<table>/g) || []).length, stats.tables);
}
const multi = await parse('IngestLab Multi-Control Form & Margin Table Test.pdf');
const html = renderMarkdown(multi.richMarkdown);
assert.match(html, /<th rowspan="2" scope="col">Line<\/th>/);
assert.match(html, /<th rowspan="2" scope="col">Schedule Description &amp; Regulatory Reference<\/th>/);
assert.match(html, /<th colspan="2">Reported Amounts \(USD\)<\/th>/);
assert.match(html, /<th scope="col">Column A \(Primary\)<\/th><th scope="col">Column B \(Adjusted\)<\/th>/);
assert.deepEqual(multi.controls.map((f) => f.checked), [true, false, true, false, true, false, true, false]);
assert.deepEqual(multi.controls.slice(0, 6).map((f) => f.label), ['Individual Return', 'Joint Consolidated Filing',
  'Schedule D Capital Adjustment', 'Amended Supplement', 'Standard Carryforward', 'Mark-to-Market Election']);
assert.equal((multi.markdown.match(/Individual Return/g) || []).length, 1);
assert.match(multi.formHtml, /for="il-control-3">Amended Supplement<\/label> <input type="checkbox" id="il-control-3"[^>]* disabled>/);
const tax = await parse('f1040 (1).pdf');
assert.equal(tax.controls.length, 199);
assert.equal(tax.controls.filter((f) => f.type === 'checkbox' && f.source === 'acroform').length, 73);
assert.equal(tax.controls.filter((f) => f.type === 'text' || f.type === 'textarea').length, 126);
assert.equal((tax.formHtml.match(/<label for=/g) || []).length, 199);
assert.doesNotMatch(tax.markdown, /_{3,}/);
assert.equal((tax.markdown.match(/\[ \]/g) || []).length, 73);
assert.doesNotMatch(tax.markdown, /\[x\]/i);
assert.match(tax.markdown, /^\| 2a \| Tax-exempt interest \|  \|\n\| 2b \| Taxable interest \|  \|$/m);
assert.match(tax.markdown, /^\| 1a \| Total amount from Form\(s\) W-2, box 1 \(see instructions\) \|  \|$/m);
assert.match(tax.markdown, /^\| \(1\) First name \|(?:  \|){4}$/m);
assert.deepEqual(tax.pages[0].filter((b) => b.type === 'table' && !b.form).map((b) => b.rows[0]),
  [['', 'Dependent 1', 'Dependent 2', 'Dependent 3', 'Dependent 4']]);
const taxSections = ['Filing Status', 'Digital Assets', 'Dependents', 'Income', 'Tax and Credits',
  'Payments and Refundable Credits', 'Refund', 'Amount You Owe', 'Third Party Designee', 'Sign Here', 'Paid Preparer Use Only'];
assert.deepEqual([...tax.markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]), taxSections);
for (const section of taxSections) {
  assert.ok(tax.markdown.includes('## ' + section + '\n\n|'), section + ' should start with a Markdown table');
}
assert.match(tax.markdown, /^\| b \| \[ \] Spouse itemizes on a separate return \|  \|$/m);
assert.match(tax.markdown, /^\| Designee’s name \|  \|\n\| Phone no\. \|  \|\n\| Personal identification number \(PIN\) \|  \|$/m);
const preview = renderMarkdown(tax.markdown, [], { allowRawHtml: false });
assert.equal((preview.match(/<input type="checkbox"/g) || []).length, 73);
assert.doesNotMatch(preview, /_{3,}/);
assert.equal((preview.match(/<table>/g) || []).length, 15);
const richPreview = renderMarkdown(tax.richMarkdown);
assert.equal((richPreview.match(/<input type="checkbox"/g) || []).length, 73);
assert.doesNotMatch(richPreview, /_{3,}/);
const field = (id, controlType, fieldValue, y0, isChecked) =>
  ({ id, controlType, fieldValue, isChecked, bbox: { x0: 10, y0, x1: 18, y1: y0 + 8 } });
const tagged = await readTaggedForm({
  getStructTree: async () => ({ children: [{ role: 'P', children: [
    { type: 'annotation', id: 'pdfjs_internal_id_a' }, { type: 'content', id: 'label' },
  ] }, { role: 'P', children: [{ type: 'annotation', id: 'pdfjs_internal_id_b' }] }] }),
  getTextContent: async () => ({ items: [{ type: 'beginMarkedContentProps', id: 'label' },
    { str: 'Selected option', transform: [1, 0, 0, 1, 20, 26] }, { type: 'endMarkedContent' }] }),
  getViewport: () => ({ convertToViewportPoint: (x, y) => [x, y] }),
}, { annotations: [field('a', 'checkbox', 'Yes', 20, true), field('b', 'text', 'Filled value', 42)] });
assert.match(emitBlocks(tagged), /\| \[x\] Selected option \|  \|\n\|  \| Filled value \|$/);
assert.equal(emitBlocks([{ type: 'form_grid', fields: [{ label: 'PIN', comb: 6 }] }]), '**PIN:**');
const radio = renderControls([
  { page: 1, type: 'radio', name: 'group', label: '<A>', exportValue: 'a', checked: true },
  { page: 1, type: 'radio', name: 'group', label: 'B', exportValue: 'b', checked: false },
]);
assert.match(radio, /&lt;A&gt;<\/label> <input type="radio" id="il-control-0" name="group" value="a" checked>/);
assert.match(radio, /<input type="radio" id="il-control-1" name="group" value="b">/);
for (const n of [1, 2]) {
  const name = names.find((f) => f.normalize('NFC') === 's\u01a1 \u0111\u1ed3 v\u00e0 bi\u1ec3u \u0111\u1ed3 ' + n + '.pdf');
  const doc = await parse(name);
  if (n === 1) {
    const figure = (id) => doc.figures.find((f) => f.bbox.caption?.startsWith('Figure ' + id + ' '));
    assert.match(figure(23).bbox.caption, /trapezoid geometry and conversion rates\./);
    assert.match(doc.markdown, /trapezoid geometry and conversion rates\./);
    for (let id = 1; id <= 86; id++) assert.ok(figure(id)?.bbox.sourcePanel, 'Missing source panel ' + id);
    assert.equal(figure(8).page, 3);
    assert.equal(figure(57).page, 20);
    for (const [id, kind, rows] of [
      [3, 'pie', ['| Prose Paragraphs | 45% |', '| Math Formulas | 10% |']],
      [5, 'grouped-bar', ['| Form 1040 | 48 | 94 |', '| ArXiv Paper | 55 | 91 |', '| Tech Spec | 62 | 96 |']],
      [6, 'line-series', ['| Category | Legacy OCR | Hybrid AST |', '| Jan | ~46 | ~42 |', '| May | ~38 | ~14 |']],
      [8, 'stacked-bar', ['| Q1 | ~40 | ~20 | ~10 | 70 |', '| Q4 | ~45 | ~32 | ~21 | 98 |']],
      [11, 'gantt', ['| Pass 3: Grid Engine | W3 | W5 |', '| Milestone: v2.0 | W6 | W6 |']],
      [13, 'box-plot', ['| Legacy OCR | ~30 | ~45 | ~60 | ~75 | ~88 | ~96 |',
        '| Hybrid AST | ~10 | ~16 | ~22 | ~28 | ~36 | ~46 |']],
      [14, 'scatter', ['| ~20 | ~8 |', '| ~190 | ~36 |']],
      [16, 'waterfall', ['| Start | $100M |', '| CapEx | -$36M |', '| End Cash | $108M |']],
      [23, 'funnel', ['| Leads | 10,000 | 100% |', '| Won | 672 | 6.7% |']],
      [24, 'treemap', ['| US Large Cap Equities | 32% | $32M |', '| Cash | 8% | - |']],
      [27, 'matrix', ['| Latency | 1.00 | 0.84 | 0.62 | -0.35 |', '| Accuracy | -0.35 | 0.12 | 0.91 | 1.00 |']],
      [69, 'responsibility-matrix', ['| Deliverable / Workstream | Tech Lead | PM | QA Eng | VP Eng |',
        '| 1. Vector AST Schema | R | C | I | A |', '| 3. Production Release | R | R | C | A |']],
      [83, 'matrix', ['| Actual Positive | TP = 460 Recall: 92.0% | FN = 40 Type II Error |',
        '| Actual Negative | FP = 25 Type I Error | TN = 475 Specificity: 95.0% |']],
    ]) {
      assert.equal(figure(id).kind2, kind);
      for (const row of rows) assert.ok(figure(id).tableMd.includes(row), row);
    }
    assert.match(figure(9).mermaid, /^stateDiagram-v2\n/);
    assert.match(figure(9).mermaid, /S1 --> S0 : retry/);
    assert.match(doc.markdown, /\| Input PDF \| (?:Connected to|Points to) \| Vector Ops \|/);
    assert.match(doc.markdown, /\| AST Builder \| (?:Connected to|Points to) \| Markdown \|/);
    assert.equal(figure(57).reconstruction, 'labels');
    assert.ok(figure(57).visualContent.labels.includes('Gini Concentration Index = 0.42'));
    for (const [key, value] of [['v1.0', 35], ['v1.1', 52], ['v1.2', 74], ['v1.3', 91]])
      assert.ok(doc.markdown.includes('| ' + key + ' | ' + value + ' |'));
    assert.doesNotMatch(doc.markdown, /^\| Level 1 \| \(Easy\)/m);
  } else {
    for (let id = 67; id <= 86; id++) assert.ok(doc.figures.some((f) =>
      f.bbox.caption?.startsWith('Level ' + id + ' ')), 'Missing source panel for level ' + id);
    assert.match(doc.markdown, /\| ED Triage; ESI Level 1–5 \| Connected to \| STAT CT \/ MRI; PACS DICOM \|/);
    assert.match(doc.markdown, /\| HL7 FHIR R4; EHR Broker \| Points to \| ICU \/ Ward; Care Plan \|/);
    assert.match(doc.markdown, /\| Agronomy ET0 Engine; [^|]+\| Points to \| VRA Center-Pivot/);
    assert.doesNotMatch(doc.markdown, /^!\[/m);
    const org = doc.figures.find((f) => f.mermaid?.includes('Global HoldCo'));
    for (const edge of ['N0 -->|80%| N1', 'N0 -->|65%| N2', 'N1 -->|50%| N3', 'N2 -->|40%| N3'])
      assert.ok(org.mermaid.includes(edge), edge);
    for (const [key, value] of [['FY25', '1,420'], ['Price', '+240'], ['Input', '-180'], ['Mix', '+160'], ['FY26', '1,640']])
      assert.ok(doc.markdown.includes('| ' + key + ' | ' + value + ' |'));
  }
}
const taxPublication = await parse('p1040.pdf');
const lookups = (n) => taxPublication.pages[n - 1].filter((b) => b.lookup).map((b) => b.rows.slice(1));
const taxPage = lookups(2);
assert.deepEqual(taxPage.map((rows) => rows.length), [4, 42, 40, 40]);
assert.deepEqual(taxPage[0][2], ['25,300', '25,350', '2,801', '2,562', '2,801', '2,699']);
assert.deepEqual(taxPage.slice(1).map((r) => r[0].slice(0, 2)), [['0', '5'], ['1,000', '1,025'], ['2,000', '2,025']]);
assert.deepEqual(taxPage[3].at(-1), ['2,975', '3,000', '299', '299', '299', '299']);
for (const [start, end, columns, lower, upper] of [[2, 13, 6, 0, 100000], [16, 27, 10, 1, 68700]]) {
  let prev = lower;
  for (let p = start; p <= end; p++) for (const rows of lookups(p).slice(p === 2 ? 1 : 0)) {
    for (const row of rows) {
      assert.equal(row.length, columns);
      assert.equal(Number(row[0].replaceAll(',', '')), prev);
      prev = Number(row[1].replaceAll(',', ''));
    }
  }
  assert.equal(prev, upper);
}
assert.deepEqual(lookups(27).map((r) => r.length), [8, 6]);
assert.deepEqual(lookups(27)[1].at(-1), ['68,650', '68,700', '0', '0', '0', '0', '0', '0', '0', '*']);

const diodes = await parse('LM358 (1).pdf');
const ti = await parse('lm358.pdf');
const pins = (doc, page) => doc.figures.find((f) => f.page === page && f.bbox.pinout).data.pins.map(([, s]) => s);
assert.deepEqual(pins(diodes, 1), [
  'OUTPUT 1', 'INVERTING INPUT 1', 'NON-INVERTING INPUT 1', 'GND',
  'NON-INVERTING INPUT 2', 'INVERTING INPUT 2', 'OUTPUT 2', 'V+',
]);
assert.deepEqual(pins(ti, 3), ['OUT1', 'IN1\u2212', 'IN1+', 'V\u2212', 'IN2+', 'IN2\u2212', 'OUT2', 'V+']);
const schematic = (doc, page, match) => doc.figures.find((f) => f.page === page &&
  f.reconstruction === 'circuit-partial' && f.data.connections.some(([name]) => name === match));
assert.deepEqual(schematic(diodes, 2, 'R2 1M').data.connections, [
  ['U1', '+: +VIN', '-: Net 2', 'OUT: +VO'],
  ['R1 10K', 'Net 2', 'GND', ''], ['R2 1M', 'Net 2', '+VO', ''],
]);
assert.deepEqual(schematic(ti, 27, 'RI').data.connections, [
  ['U1', '+: GND', '-: Net 2', 'OUT: VOUT'],
  ['RF', 'Net 2', 'VOUT', ''], ['RI', 'VIN', 'Net 2', ''],
]);
assert.deepEqual(schematic(ti, 29, 'RIN').data.connections, [
  ['U1', '+: Net 1', '-: Net 2', 'OUT: VOUT'],
  ['RIN', 'VIN', 'Net 1', ''], ['RG', 'GND', 'Net 2', ''], ['RF', 'Net 2', 'VOUT', ''],
]);
assert.match(ti.markdown, /Partial schematic: traced connections only/);
console.log('Corpus regressions: tables, PDF controls, diagram fixtures and both LM358 datasheets OK');
