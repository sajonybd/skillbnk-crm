import { api } from '../api.js';
import { h, fill, toast, fmtDateTime } from '../util.js';
import { renderMd } from './reports.js';

const state = { tab: 'plan' };

export async function render(root, ctx) {
  const isAdmin = ctx.user.role === 'admin';
  const tabs = h('div', { class: 'seg' });
  const body = h('div');
  root.replaceChildren(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Playbook'), h('div', { class: 'muted' }, 'The marketing plan and the rules the daily plan follows. Only the admin can change them; everyone can ask.')), h('div', { class: 'spacer' }), tabs), body);
  let data = await api('GET', '/api/playbook');

  async function reload() { data = await api('GET', '/api/playbook'); draw(); }

  function draw() {
    const tab = (k, t) => h('button', { class: 'segb' + (state.tab === k ? ' on' : ''), onclick: () => { state.tab = k; draw(); } }, t);
    tabs.replaceChildren(tab('plan', 'Marketing plan'), tab('rules', 'Rules & limits'), tab('requests', isAdmin ? `Requests${data.open_requests ? ` (${data.open_requests})` : ''}` : 'Ask the admin'));
    ({ plan: drawPlan, rules: drawRules, requests: drawRequests })[state.tab]();
  }

  // ── plan text ──
  function drawPlan() {
    const view = h('div');
    const show = () => fill(view, h('div', { class: 'muted', style: 'margin-bottom:8px' }, data.updated_at ? `Last updated ${fmtDateTime(data.updated_at)} by ${data.updated_by}` : 'Default text. Not edited yet.'), renderMd(data.markdown));
    show();
    const actions = isAdmin ? h('div', { class: 'rep-bar' }, h('button', { class: 'btn primary', onclick: edit }, 'Edit plan text')) : null;
    function edit() {
      const ta = h('textarea', { rows: 28, style: 'width:100%;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5' });
      ta.value = data.markdown;
      fill(view, h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Markdown: # heading, ## subheading, - bullet, 1. numbered, **bold**, | tables |.'), ta,
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn primary', onclick: async () => { try { await api('PUT', '/api/playbook/plan', { markdown: ta.value }); toast('Plan saved'); reload(); } catch (e) { toast(e.message, true); } } }, 'Save'),
          h('button', { class: 'btn', onclick: show }, 'Cancel')));
    }
    body.replaceChildren(...[actions, view].filter(Boolean));
  }

  // ── rules ──
  function drawRules() {
    const inputs = {};
    const rows = Object.entries(data.defs).map(([k, d]) => {
      const inp = h('input', { type: 'number', min: d.min, max: d.max, value: data.rules[k], style: 'width:90px' });
      inp.disabled = !isAdmin;
      inputs[k] = inp;
      return h('div', { class: 'rule' }, h('div', null, h('b', null, d.label), h('div', { class: 'sub' }, d.help + ` (default ${d.def})`)), inp);
    });
    const caps = {};
    const capRows = data.caps.map((c) => {
      const inp = h('input', { type: 'number', min: 1, max: 200, value: c.custom ? c.cap : '', placeholder: String(data.rules.daily_cap), style: 'width:90px' });
      inp.disabled = !isAdmin;
      caps[c.user_id] = inp;
      return h('div', { class: 'rule' }, h('div', null, h('b', null, c.name), h('div', { class: 'sub' }, 'Daily lead actions. Leave empty to use the team number.')), inp);
    });
    const save = isAdmin ? h('button', { class: 'btn primary', onclick: async () => {
      try {
        await api('PUT', '/api/playbook/rules', {
          rules: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])),
          caps: data.caps.map((c) => ({ user_id: c.user_id, cap: caps[c.user_id].value })),
        });
        toast('Rules saved. The Plan uses them now.'); reload();
      } catch (e) { toast(e.message, true); }
    } }, 'Save rules') : null;
    body.replaceChildren(
      h('div', { class: 'card pcard', style: 'max-width:820px' }, h('div', { class: 'pc-title' }, h('h3', null, 'Follow-up cadence and limits')), ...rows),
      h('div', { class: 'card pcard', style: 'max-width:820px;margin-top:14px' }, h('div', { class: 'pc-title' }, h('h3', null, 'Daily lead actions per person')), ...capRows,
        h('div', { class: 'muted', style: 'margin-top:8px' }, 'Daily targets (comments, likes, DMs…) are on the Targets page. Team tasks are on the Tasks page.')),
      save ? h('div', { style: 'margin-top:12px' }, save) : h('div', { class: 'muted', style: 'margin-top:12px' }, 'Only the admin can change these. Use "Ask the admin" if a number should change.'));
  }

  // ── requests ──
  function drawRequests() {
    const title = h('input', { placeholder: 'What should change? (short)', style: 'width:100%' });
    const details = h('textarea', { rows: 4, placeholder: 'Why, and what exactly (for example "reduce my daily limit to 15 because each message needs research")', style: 'width:100%' });
    const form = h('div', { class: 'card pcard', style: 'max-width:820px;margin-bottom:14px' }, h('div', { class: 'pc-title' }, h('h3', null, 'Ask the admin to change the plan')), title, h('div', { style: 'height:8px' }), details,
      h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn primary', onclick: async () => {
        try { await api('POST', '/api/playbook/requests', { title: title.value, details: details.value }); toast('Sent to the admin'); reload(); } catch (e) { toast(e.message, true); }
      } }, 'Send request')));
    const list = data.requests.map((q) => {
      const note = h('input', { placeholder: 'Note to the requester (optional)', value: q.admin_note, style: 'width:100%;margin-top:8px' });
      const set = async (status) => { try { await api('PATCH', `/api/playbook/requests/${q.id}`, { status, admin_note: note.value }); toast('Saved'); reload(); } catch (e) { toast(e.message, true); } };
      return h('div', { class: 'card pcard', style: 'max-width:820px;margin-bottom:10px' },
        h('div', { class: 'row' }, h('b', null, q.title), h('span', { class: 'kind ' + (q.status === 'open' ? 'warm' : q.status === 'declined' ? 'muted' : 'cool') }, q.status), h('div', { class: 'spacer' }), h('span', { class: 'sub' }, `${q.user_name} · ${fmtDateTime(q.created_at)}`)),
        q.details ? h('p', { style: 'white-space:pre-wrap;margin:8px 0' }, q.details) : null,
        isAdmin ? h('div', null, note, h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'btn small primary', onclick: () => set('approved') }, 'Approve'), h('button', { class: 'btn small', onclick: () => set('done') }, 'Mark done'), h('button', { class: 'btn small', onclick: () => set('declined') }, 'Decline')))
          : (q.admin_note ? h('div', { class: 'sub' }, 'Admin: ' + q.admin_note) : null));
    });
    body.replaceChildren(...[form, ...(list.length ? list : [h('div', { class: 'muted' }, 'No requests yet.')])]);
  }
  draw();
}
