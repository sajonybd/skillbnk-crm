import { api } from '../api.js';
import { h, options, toast } from '../util.js';

export async function render(root, ctx) {
  let text = '';
  let fileName = '';
  const stepsBox = h('div', { class: 'steps' });
  root.replaceChildren(h('div', { class: 'page-head' }, h('h1', null, 'Import leads')), stepsBox);

  // ── Step 1: get the data ──
  const paste = h('textarea', { rows: 6, placeholder: 'Paste rows copied from Google Sheets here (include the header row)…' });
  const fileInput = h('input', { type: 'file', accept: '.csv,.tsv,.txt' });
  const source = h('input', { placeholder: 'e.g. Apollo Nov 2026 – L&D Employers', style: 'width:320px' });
  const previewBtn = h('button', { class: 'btn primary' }, 'Preview import');
  const step1 = h('div', { class: 'card step' },
    h('h2', null, '1. Add your leads'),
    h('p', { class: 'muted', style: 'margin-top:0' }, 'In Google Sheets: select the cells and copy, or File → Download → CSV. Column names are matched automatically (Master Leads and Apollo exports both work).'),
    h('div', { class: 'dropzone' }, h('div', { class: 'row' }, fileInput, h('span', { class: 'muted' }, 'or paste below')), h('div', { style: 'margin-top:10px' }, paste)),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('label', { class: 'muted' }, 'Source label (optional):'), source, previewBtn));
  const step2 = h('div');
  const step3 = h('div');
  stepsBox.append(step1, step2, step3);

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    fileName = f.name;
    paste.value = '';
    text = await f.text();
    if (!source.value) source.value = f.name.replace(/\.[^.]+$/, '');
    toast(`Loaded ${f.name}`);
  });
  paste.addEventListener('input', () => { text = paste.value; fileName = ''; });

  previewBtn.addEventListener('click', async () => {
    if (!text.trim()) return toast('Choose a file or paste data first', true);
    previewBtn.disabled = true;
    try { showPreview(await api('POST', '/api/import/preview', { text })); }
    catch (e) { toast(e.message, true); }
    previewBtn.disabled = false;
  });

  // ── Step 2: check mapping, choose assignment ──
  function showPreview(p) {
    step3.replaceChildren();
    const mapping = [...p.mapping];
    const maps = p.headers.map((hd, i) => {
      const s = h('select', { value: mapping[i], onchange: () => { mapping[i] = s.value; } },
        options(p.fields, { blank: '— skip this column —' }));
      s.value = mapping[i];
      return s;
    });
    const sampleOf = (i) => p.sample.map((r) => r[i]).filter(Boolean).slice(0, 2).join(' · ');

    const mode = h('select', null,
      h('option', { value: 'none' }, "Don't assign (use the Owner column if there is one)"),
      h('option', { value: 'user' }, 'Assign all to one person'),
      h('option', { value: 'split' }, 'Split evenly between selected people'));
    const checks = ctx.users.filter((u) => u.active).map((u) => ({ u, cb: h('input', { type: 'checkbox' }) }));
    const checkBox = h('div', { class: 'checks', style: 'margin-top:10px;display:none' },
      checks.map(({ u, cb }) => h('label', null, cb, u.name)));
    mode.addEventListener('change', () => { checkBox.style.display = mode.value === 'none' ? 'none' : ''; });

    const upd = h('input', { type: 'checkbox' });
    const go = h('button', { class: 'btn primary', disabled: p.newCount === 0 && p.duplicateCount === 0, onclick: async () => {
      const user_ids = checks.filter((c) => c.cb.checked).map((c) => c.u.id);
      if (mode.value === 'user' && user_ids.length !== 1) return toast('Pick exactly one person', true);
      if (mode.value === 'split' && user_ids.length < 2) return toast('Pick two or more people to split between', true);
      go.disabled = true; go.textContent = 'Importing…';
      try {
        const r = await api('POST', '/api/import/commit', { text, mapping, source: source.value, update: upd.checked, assign: { mode: mode.value, user_ids } });
        await ctx.reloadUsers();
        showResult(r);
      } catch (e) { toast(e.message, true); go.disabled = false; go.textContent = `Import ${p.newCount.toLocaleString()} new leads`; }
    } }, `Import ${p.newCount.toLocaleString()} new leads`);

    step2.replaceChildren(h('div', { class: 'card step' },
      h('h2', null, '2. Check and import'),
      h('label', { class: 'row', style: 'margin-bottom:10px' }, upd, h('span', null, 'Also update leads already in the CRM: fill their blank fields and add missing meetings and activity history (nothing you typed is overwritten)')),
      h('div', { class: 'stats' },
        stat(p.totalRows, 'rows read'), stat(p.newCount, 'new leads'), stat(p.duplicateCount, 'already in CRM (skipped)'), stat(p.invalidCount, 'unusable rows')),
      p.trashedCount ? h('p', { class: 'muted' }, `${p.trashedCount} of the skipped rows are in the Recycle bin. Restore them there if you want them back.`) : null,
      h('h3', { style: 'margin:18px 0 8px' }, 'Column mapping'),
      h('div', { class: 'mapgrid' },
        h('div', { class: 'hd' }, 'Your column'), h('div', { class: 'hd' }, 'Goes into'), h('div', { class: 'hd' }, 'Example'),
        p.headers.flatMap((hd, i) => [h('div', null, hd || '(blank)'), maps[i], h('div', { class: 'sample' }, sampleOf(i))])),
      h('h3', { style: 'margin:18px 0 8px' }, 'Assignment'), mode, checkBox,
      h('div', { style: 'margin-top:18px' }, go)));
    step2.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showResult(r) {
    step2.replaceChildren();
    const owners = Object.entries(r.byOwner);
    step3.replaceChildren(h('div', { class: 'card step' },
      h('h2', null, `Done — ${r.created.toLocaleString()} leads imported`),
      h('div', { class: 'stats' }, stat(r.created, 'added'), stat(r.duplicates, 'duplicates skipped'), stat(r.invalid, 'unusable rows')),
      r.inBin ? h('p', { class: 'muted' }, `${r.inBin} skipped lead(s) are in the Recycle bin. Restore them from the Recycle bin page.`) : null,
      owners.length ? h('p', null, 'Assigned: ', owners.map(([n, c]) => `${n} ${c.toLocaleString()}`).join(' · ')) : null,
      Object.keys(r.unknownOwners || {}).length ? h('p', { class: 'muted' }, 'Owner names that are not on your team were left Unassigned: ' + Object.entries(r.unknownOwners).map(([n, c]) => `${n} (${c.toLocaleString()})`).join(', ') + '. Assign them from the Leads page.') : null,
      r.createdUsers.length ? h('p', { class: 'muted' }, `New team accounts created from the Owner column: ${r.createdUsers.join(', ')}. Set their email and password in Team.`) : null,
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: '#/leads' }, 'View leads'),
        h('button', { class: 'btn', onclick: () => render(root, ctx) }, 'Import another file'))));
    step3.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

const stat = (n, label) => h('div', { class: 'stat' }, h('b', null, Number(n).toLocaleString()), h('span', { class: 'muted' }, label));
