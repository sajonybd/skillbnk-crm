import { api, qs } from '../api.js';
import { drawPager, h, fill, debounce, options, pref, pill, fullName, timeAgo, todayStr, toast, avatar, copyText, asUrl, shortDate } from '../util.js';
import { icon, TYPE_ICON } from '../icons.js';
import { openLead, openNewLead } from './lead-drawer.js';
import { watchVisit } from '../visit.js';

// Filters survive page switches within the session.
const state = { q: '', owner: '', stage: '', quality: '', source: '', due: '', untouched: '', meeting: '', page: 1, limit: 50, sort: 'next_action_date', dir: 'asc', _init: false };
if (state.sort === 'first_name') state.sort = 'name';

// [key, label, default direction]
const SORTS = [
  ['updated_at', 'Recently updated', 'desc'], ['created_at', 'Date imported', 'desc'], ['name', 'Name', 'asc'],
  ['company', 'Company', 'asc'], ['owner', 'Owner', 'asc'], ['stage', 'Stage (pipeline order)', 'asc'],
  ['quality', 'Quality', 'asc'], ['last_activity_at', 'Last activity', 'desc'], ['touches', 'Most touched', 'desc'],
  ['next_action_date', 'Next action date', 'asc'], ['meeting_date', 'Meeting date', 'asc'],
];
const selected = new Set();

// ── small floating menu (used for the LinkedIn quick-log) ──
let closeMenu = () => {};
function openMenu(anchor, title, items) {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'menu', style: `top:${Math.min(r.bottom + 4, innerHeight - 20 - items.length * 34)}px;left:${Math.max(8, Math.min(r.left, innerWidth - 210))}px` },
    h('div', { class: 'hd' }, h('h3', null, title)),
    items.map((it) => h('button', { onclick: () => { closeMenu(); it.run(); } }, icon(it.icon, 15), it.label)));
  const off = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  const esc = (e) => { if (e.key === 'Escape') closeMenu(); };
  closeMenu = () => { menu.remove(); document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); removeEventListener('scroll', closeMenu, true); closeMenu = () => {}; };
  document.body.append(menu);
  setTimeout(() => { document.addEventListener('mousedown', off); document.addEventListener('keydown', esc); addEventListener('scroll', closeMenu, true); });
}

export async function render(root, ctx) {
  const [facets, tabs, kpiData] = await Promise.all([api('GET', '/api/leads/facets'), api('GET', '/api/activity/tabs'), api('GET', '/api/kpi')]);
  const { stages, qualities, typeLabels, linkedinTypes } = ctx.config;
  const activeUsers = ctx.users.filter((u) => u.active);
  if (!state._init) { // first visit after sign-in: your own leads, sorted by what needs doing next; later visits keep your last choice
    state._init = true;
    const me = ctx.user.id;
    state.owner = pref.get(me, 'leads.owner', ctx.user.role === 'admin' ? '' : String(me));
    state.sort = pref.get(me, 'leads.sort', 'next_action_date'); state.dir = pref.get(me, 'leads.dir', 'asc');
    state.limit = Number(pref.get(me, 'leads.limit', '50')) || 50;
  }
  const savePrefs = () => { const me = ctx.user.id; pref.set(me, 'leads.owner', state.owner); pref.set(me, 'leads.sort', state.sort); pref.set(me, 'leads.dir', state.dir); pref.set(me, 'leads.limit', state.limit); };
  const isAdmin = ctx.user.role === 'admin';

  // ── KPI strip ──
  const kpis = h('div', { class: 'kpis' });
  const kpi = (tone, ic, label, value, note, href) => h('div', { class: 'card kpi', style: href ? 'cursor:pointer' : '', onclick: href ? () => { location.hash = href; } : null },
    h('div', { class: 'ic ' + tone }, icon(ic, 19)),
    h('div', null, h('div', { class: 'lbl' }, label), h('div', { class: 'val' }, typeof value === 'number' ? value.toLocaleString() : value, note ? h('small', null, note) : null)));
  function kpiCard() {
    const mine = kpiData.members.find((m) => m.id === ctx.user.id);
    const src = mine || { booked: kpiData.members.reduce((a, m) => a + m.booked, 0), target: kpiData.members.reduce((a, m) => a + m.target, 0), carry_in: 0 };
    const carry = mine && mine.carry_in ? ` · +${mine.carry_in} carried` : '';
    return kpi('t-pink', 'target', mine ? 'My weekly KPI' : 'Team weekly KPI', `${src.booked}/${src.target}`, `meetings${carry}`, '#/meetings');
  }
  function drawKpis() {
    fill(kpis,
      kpi('t-blue', 'users', 'Total leads', facets.total),
      kpi('t-purple', 'chart', 'Touches today', tabs.today),
      kpi('t-green', 'calendar', 'Upcoming meetings', facets.upcomingMeetings, '', '#/meetings'),
      kpiCard(),
      kpi('t-orange', 'clock', 'Follow-ups due', facets.due),
      kpi('t-teal', 'inbox', 'Untouched', facets.untouched));
  }

  // ── filters ──
  const sel = (key, children) => {
    const s = h('select', { value: state[key], onchange: () => { state[key] = s.value; state.page = 1; load(); } }, children);
    return s;
  };
  const search = h('input', { type: 'search', placeholder: 'Search name, title, company, email…', value: state.q,
    oninput: debounce(() => { state.q = search.value; state.page = 1; load(); }) });
  const stageSel = sel('stage', options(stages.map((s) => [s, `${s} (${facets.stages[s] || 0})`]), { blank: 'All stages' }));
  const qualSel = sel('quality', [
    h('option', { value: '' }, 'Any quality'),
    h('option', { value: 'none' }, `Unrated (${facets.qualities[''] || 0})`),
    ...qualities.map((q) => h('option', { value: q }, `${q} (${facets.qualities[q] || 0})`)),
  ]);
  const srcSel = sel('source', options(facets.sources.map((s) => [s.k, `${s.k} (${s.n})`]), { blank: 'All sources' }));

  const sortSel = h('select', { onchange: () => {
    const o = SORTS.find((x) => x[0] === sortSel.value);
    state.sort = o[0]; state.dir = o[2]; state.page = 1; syncSort(); load();
  } }, SORTS.map(([k, label]) => h('option', { value: k }, label)));
  const dirBtn = h('button', { class: 'btn sq', onclick: () => { state.dir = state.dir === 'asc' ? 'desc' : 'asc'; state.page = 1; syncSort(); load(); } });
  const perSel = h('select', { onchange: () => { state.limit = Number(perSel.value); state.page = 1; load(); } },
    [20, 50, 100, 200].map((n) => h('option', { value: n }, `${n} per page`)));
  function syncSort() {
    sortSel.value = SORTS.some((x) => x[0] === state.sort) ? state.sort : 'updated_at';
    dirBtn.title = state.dir === 'asc' ? 'Ascending (click to reverse)' : 'Descending (click to reverse)';
    fill(dirBtn, icon(state.dir === 'asc' ? 'arrowUp' : 'arrowDown', 14));
    if (tableWrap.firstChild) drawTable();
  }
  const sortbox = h('div', { class: 'sortbox' }, 'Sort', sortSel, dirBtn, perSel);

  const toggles = h('div', { class: 'row' });
  function drawToggles() {
    const t = (key, label, n, ic) => h('button', { class: 'toggle' + (state[key] ? ' on' : ''), onclick: () => { state[key] = state[key] ? '' : '1'; state.page = 1; drawToggles(); load(); } },
      icon(ic, 14), label, h('span', { class: 'n' }, n != null ? `(${n})` : ''));
    fill(toggles, t('untouched', 'Untouched', facets.untouched, 'inbox'), t('due', 'Follow-ups due', facets.due, 'clock'), t('meeting', 'Has meeting', facets.meetings, 'calendar'));
  }

  const chips = h('div', { class: 'chips' });
  function drawChips() {
    const chip = (value, label, n, av) => h('button', { class: 'chip' + (state.owner === value ? ' on' : '') + (av ? '' : ' noav'),
      onclick: () => { state.owner = value; state.page = 1; drawChips(); load(); } },
      av ? avatar(label, 22) : null, label, h('span', { class: 'n' }, `(${(n || 0).toLocaleString()})`));
    fill(chips, h('span', { class: 'muted', style: 'margin-right:2px' }, icon('users', 15)),
      chip('', 'All', facets.total),
      ...activeUsers.filter((u) => u.role !== 'admin' || facets.owners[u.id]).map((u) => chip(String(u.id), u.name, facets.owners[u.id], true)),
      chip('none', 'Unassigned', facets.owners['']));
  }

  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'searchbox' }, icon('search', 15), search), stageSel, qualSel, srcSel, toggles,
    h('div', { class: 'spacer' }), sortbox, h('span', { class: 'muted', id: 'count' }),
    isAdmin ? h('a', { class: 'btn', href: '#/trash', title: 'Deleted leads' }, icon('trash', 14), 'Recycle bin', facets.trash ? h('span', { class: 'muted' }, `(${facets.trash})`) : null) : null,
    h('button', { class: 'btn primary', onclick: () => openNewLead(ctx, () => refresh()) }, icon('plus', 15), 'Add lead'));
  const chipbar = h('div', { class: 'toolbar', style: 'padding:8px 14px' }, chips);
  const bulk = h('div', { class: 'bulkbar', style: 'display:none' });
  const tableWrap = h('div', { class: 'tablewrap' });
  const pager = h('div', { class: 'pager' });

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', null, 'Leads')),
    kpis, h('div', { class: 'card' }, toolbar, chipbar, bulk, tableWrap, pager));

  let data = { rows: [], total: 0 };

  async function refresh() { // reload counts + list after any edit
    const [f, t, k] = await Promise.all([api('GET', '/api/leads/facets'), api('GET', '/api/activity/tabs'), api('GET', '/api/kpi')]);
    Object.assign(facets, f); Object.assign(tabs, t); Object.assign(kpiData, k);
    drawKpis(); drawChips(); drawToggles();
    await load();
  }

  async function load() {
    savePrefs();
    data = await api('GET', '/api/leads?' + qs(state));
    toolbar.querySelector('#count').textContent = `${data.total.toLocaleString()} match`;
    drawTable(); drawPagerNow(); drawBulk();
  }

  async function patch(l, body, msg) {
    try { await api('PATCH', `/api/leads/${l.id}`, body); toast(msg); } catch (e) { toast(e.message, true); }
    refresh();
  }
  async function quickLog(l, type) {
    try { await api('POST', `/api/leads/${l.id}/activities`, { type }); toast(`${typeLabels[type]} logged for ${fullName(l)}`); }
    catch (e) { toast(e.message, true); }
    refresh();
  }

  const header = (label, sortKey) => h('th', sortKey
    ? { class: 'sortable', onclick: () => {
        if (state.sort === sortKey) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.sort = sortKey; state.dir = SORTS.find((x) => x[0] === sortKey)?.[2] || 'asc'; }
        state.page = 1; syncSort(); load();
      } }
    : {}, label + (state.sort === sortKey ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ''));
  const lazyRefresh = debounce(() => refresh(), 800);

  // `track` = 'person' | 'company' logs a profile visit (once per person, lead and day) when clicked.
  function linkBtn(cls, ic, text, href, title, lead, track) {
    const a = h('a', { class: `lk ${cls}${href ? '' : ' off'}`, href: href || null, target: '_blank', rel: 'noopener', title: href ? title : `No ${title.toLowerCase()}`, onclick: (e) => e.stopPropagation() }, icon(ic, 12), text);
    if (track && href) watchVisit(a, lead.id, track, fullName(lead), lazyRefresh);
    return a;
  }

  function meetChip(l, open) {
    if (!l.meeting_status) return null;
    const late = l.meeting_status === 'booked' && l.meeting_date < todayStr();
    const label = ctx.config.meetingStatuses[l.meeting_status];
    return h('a', { class: `mchip ${l.meeting_status}${late ? ' late' : ''}`, title: late ? 'Meeting date passed — update its status' : 'Open meetings', onclick: open },
      icon('calendar', 12), `${label} · ${shortDate(l.meeting_date)}`);
  }

  function drawTable() {
    if (data.rows.length === 0) {
      fill(tableWrap, h('div', { class: 'empty' }, facets.total === 0 ? 'No leads yet — go to Import to add your first batch.' : 'No leads match these filters.'));
      return;
    }
    const allOnPage = data.rows.every((r) => selected.has(r.id));
    const master = h('input', { type: 'checkbox', checked: allOnPage, onchange: () => {
      data.rows.forEach((r) => (master.checked ? selected.add(r.id) : selected.delete(r.id)));
      drawTable(); drawBulk();
    } });
    const today = todayStr();

    fill(tableWrap, h('table', null,
      h('thead', null, h('tr', null,
        h('th', { style: 'width:32px' }, master),
        header('Lead', 'name'), header('Company', 'company'), h('th', null, 'Email & links'),
        header('Owner', 'owner'), header('Stage / quality', 'stage'),
        h('th', null, 'Log activity'), header('Last activity', 'last_activity_at'))),
      h('tbody', null, data.rows.map((l) => {
        const cb = h('input', { type: 'checkbox', checked: selected.has(l.id),
          onchange: () => { cb.checked ? selected.add(l.id) : selected.delete(l.id); tr.classList.toggle('sel', cb.checked); drawBulk(); } });
        const open = () => openLead(l.id, ctx, refresh);
        const where = [l.city, l.state || (l.city ? '' : l.country)].filter(Boolean).join(', ');

        // inline selects
        const owner = h('select', { class: 'inl ' + (l.owner_id ? 'own' : 'empty'), onchange: () => patch(l, { owner_id: owner.value === '' ? null : Number(owner.value) }, 'Reassigned') },
          h('option', { value: '' }, 'Unassigned'), ...activeUsers.map((u) => h('option', { value: u.id }, u.name)));
        if (l.owner_id && !activeUsers.some((u) => u.id === l.owner_id)) owner.append(h('option', { value: l.owner_id }, l.owner_name + ' (inactive)'));
        owner.value = l.owner_id ?? '';
        const stage = h('select', { class: 'inl', onchange: () => patch(l, { stage: stage.value }, 'Stage updated') }, options(stages));
        stage.value = l.stage;
        const quality = h('select', { class: 'inl' + (l.quality ? '' : ' empty'), onchange: () => patch(l, { quality: quality.value }, 'Quality updated') }, options(qualities, { blank: 'Unrated' }));
        quality.value = l.quality;

        // email + copy
        const st = (l.email_status || '').toLowerCase();
        const copyBtn = h('button', { class: 'ib', title: 'Copy email', onclick: async () => { await copyText(l.email); copyBtn.classList.add('ok'); copyBtn.replaceChildren(icon('check', 14)); setTimeout(() => { copyBtn.classList.remove('ok'); copyBtn.replaceChildren(icon('copy', 14)); }, 1200); } }, icon('copy', 14));

        // quick-log buttons
        const liBtn = h('button', { class: 'ib li', title: 'Log a LinkedIn action', onclick: () => openMenu(liBtn, 'LinkedIn action', linkedinTypes.map((t) => ({ icon: TYPE_ICON[t], label: typeLabels[t], run: () => quickLog(l, t) }))) }, icon('linkedin', 14));
        const logBtns = h('div', { class: 'ibs' },
          h('button', { class: 'ib call', title: 'Log a call', onclick: () => quickLog(l, 'call') }, icon('phone', 14)),
          h('button', { class: 'ib mail', title: 'Log an email', onclick: () => quickLog(l, 'email') }, icon('mail', 14)),
          liBtn,
          h('button', { class: 'ib cal', title: 'Meeting / note…', onclick: open }, icon('calendar', 14)),
          h('button', { class: 'ib', title: 'History', onclick: open }, icon('clock', 14), l.activity_count ? h('span', { class: 'badge' }, l.activity_count) : null),
          isAdmin ? h('button', { class: 'ib del', title: 'Move to recycle bin', onclick: async () => {
            try { await api('DELETE', `/api/leads/${l.id}`); selected.delete(l.id); toast(`${fullName(l)} moved to recycle bin`); } catch (e) { toast(e.message, true); }
            refresh();
          } }, icon('trash', 14)) : null);

        const due = l.next_action_date && l.next_action_date <= today;
        const tr = h('tr', { class: selected.has(l.id) ? 'sel' : '' },
          h('td', null, cb),
          h('td', null, h('div', { class: 'leadcell' }, avatar(fullName(l), 32),
            h('div', null, h('a', { class: 'nm', onclick: open }, fullName(l)), h('div', { class: 'sub' }, l.title), where ? h('div', { class: 'sub' }, where) : null))),
          h('td', { class: 'company' }, h('div', { class: 'nm' }, l.company), h('div', { class: 'sub' }, [l.industry, l.employees ? `${l.employees} emp` : ''].filter(Boolean).join(' · ')),
            l.source ? h('div', { style: 'margin-top:4px' }, h('span', { class: 'srcpill', title: l.source }, l.source)) : null),
          h('td', null,
            l.email ? h('div', { class: 'emailcell' }, h('span', { class: 'vdot' + (st === 'verified' ? ' v' : st ? ' b' : ''), title: l.email_status || 'Unknown status' }),
              h('a', { class: 'em', href: 'mailto:' + l.email, title: l.email }, l.email), copyBtn) : h('span', { class: 'muted' }, 'No email'),
            h('div', { class: 'linksline' },
              linkBtn('li', 'linkedin', 'LI', asUrl(l.linkedin), 'Personal LinkedIn profile (visit is logged)', l, 'person'),
              linkBtn('co', 'building', 'Co', asUrl(l.company_linkedin), 'Company LinkedIn page (visit is logged)', l, 'company'),
              linkBtn('web', 'globe', 'Web', asUrl(l.website), 'Company website'),
              l.drive_url ? linkBtn('drive', 'folder', 'Drive', l.drive_url, 'Google Drive') : null,
              l.chatgpt_url ? linkBtn('gpt', 'sparkles', 'GPT', l.chatgpt_url, 'ChatGPT chat') : null,
              l.link_count > (l.drive_url ? 1 : 0) + (l.chatgpt_url ? 1 : 0) ? h('a', { class: 'lk', title: 'More links', onclick: open }, icon('link', 12), '+') : null)),
          h('td', null, owner),
          h('td', null, h('div', { style: 'display:grid;gap:5px' }, stage, quality, meetChip(l, open))),
          h('td', null, logBtns),
          h('td', null, h('div', { class: 'lastact' }, l.last_type ? icon(TYPE_ICON[l.last_type] || 'clock', 14) : null,
              l.last_activity_at ? `${typeLabels[l.last_type] || 'Update'} · ${timeAgo(l.last_activity_at)}` : 'Never touched'),
            l.next_action || l.next_action_date ? h('div', { class: 'sub' + (due ? ' due' : '') }, [l.next_action, l.next_action_date].filter(Boolean).join(' · ')) : null));
        return tr;
      }))));
  }

  function drawPagerNow() {
    drawPager(pager, { page: state.page, limit: state.limit, total: data.total, onPage: (n) => { state.page = n; load().then(() => root.scrollIntoView?.({ block: 'start' })); } });
  }

  function drawBulk() {
    if (selected.size === 0) { bulk.style.display = 'none'; return; }
    bulk.style.display = '';
    const ownerPick = h('select', null, h('option', { value: '' }, 'Assign to…'),
      h('option', { value: 'none' }, 'Unassigned'), ...activeUsers.map((u) => h('option', { value: u.id }, u.name)));
    const stagePick = h('select', null, options(stages, { blank: 'Set stage…' }));
    const qualPick = h('select', null, [h('option', { value: '' }, 'Set quality…'), h('option', { value: 'none' }, 'Unrated'), ...options(qualities)]);
    const apply = h('button', { class: 'btn primary', onclick: async () => {
      const set = {};
      if (ownerPick.value) set.owner_id = ownerPick.value === 'none' ? null : Number(ownerPick.value);
      if (stagePick.value) set.stage = stagePick.value;
      if (qualPick.value) set.quality = qualPick.value === 'none' ? '' : qualPick.value;
      if (!Object.keys(set).length) return toast('Choose something to change', true);
      if (!confirm(`Apply to ${selected.size} lead(s)?`)) return;
      try {
        const r = await api('POST', '/api/leads/bulk', { ids: [...selected], set });
        toast(`Updated ${r.changed} lead(s)`);
        selected.clear();
        refresh();
      } catch (e) { toast(e.message, true); }
    } }, 'Apply');
    const selectAll = data.total > selected.size
      ? h('button', { class: 'btn small', onclick: async () => {
          const { ids } = await api('GET', '/api/leads/ids?' + qs(state));
          ids.forEach((i) => selected.add(i));
          if (data.total > ids.length) toast(`Selected the first ${ids.length} (max 5000)`);
          drawTable(); drawBulk();
        } }, `Select all ${data.total.toLocaleString()} matching`) : null;
    const del = isAdmin ? h('button', { class: 'btn small danger', title: 'Move to recycle bin', onclick: async () => {
      if (!confirm(`Move ${selected.size} lead(s) to the recycle bin?\n\nYou can restore them from the Recycle bin page.`)) return;
      try {
        const r = await api('POST', '/api/leads/bulk-delete', { ids: [...selected] });
        toast(`${r.deleted} lead(s) moved to recycle bin`);
        selected.clear();
      } catch (e) { toast(e.message, true); }
      refresh();
    } }, icon('trash', 13), 'Delete') : null;
    fill(bulk, h('b', null, `${selected.size} selected`), selectAll, ownerPick, stagePick, qualPick, apply, del,
      h('button', { class: 'btn small', onclick: () => { selected.clear(); drawTable(); drawBulk(); } }, 'Clear'));
  }

  perSel.value = String(state.limit); syncSort();
  stageSel.value = state.stage; qualSel.value = state.quality; srcSel.value = state.source;
  drawKpis(); drawChips(); drawToggles();
  await load();
}
