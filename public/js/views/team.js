import { api } from '../api.js';
import { h, toast } from '../util.js';

export async function render(root, ctx) {
  const box = h('div', { class: 'card', style: 'margin-bottom:16px' });
  const name = h('input', { placeholder: 'Full name' });
  const email = h('input', { type: 'email', placeholder: 'Email' });
  const pw = h('input', { placeholder: 'Password (min 6)', type: 'text' });
  const role = h('select', null, h('option', { value: 'member' }, 'Member'), h('option', { value: 'admin' }, 'Admin'));

  const add = h('button', { class: 'btn primary', onclick: async () => {
    try {
      await api('POST', '/api/team', { name: name.value, email: email.value, password: pw.value, role: role.value });
      name.value = email.value = pw.value = '';
      toast('Team member added');
      await reload();
    } catch (e) { toast(e.message, true); }
  } }, 'Add member');

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', null, 'Team')),
    box,
    h('div', { class: 'card', style: 'padding:16px' }, h('h2', { style: 'margin-bottom:10px' }, 'Add team member'),
      h('div', { class: 'row' }, name, email, pw, role, add)));

  async function patch(id, body, msg) {
    try { await api('PATCH', `/api/team/${id}`, body); toast(msg); await reload(); }
    catch (e) { toast(e.message, true); await reload(); }
  }

  async function reload() {
    await ctx.reloadUsers();
    box.replaceChildren(h('table', null,
      h('thead', null, h('tr', null, ['Name', 'Email', 'Role', 'Leads', 'Status', ''].map((t) => h('th', null, t)))),
      h('tbody', null, ctx.users.map((u) => {
        const roleSel = h('select', { onchange: () => patch(u.id, { role: roleSel.value }, 'Role updated') },
          h('option', { value: 'member' }, 'Member'), h('option', { value: 'admin' }, 'Admin'));
        roleSel.value = u.role;
        roleSel.disabled = u.id === ctx.user.id;
        return h('tr', null,
          h('td', null, h('b', null, u.name)),
          h('td', null, u.email),
          h('td', null, roleSel),
          h('td', null, u.lead_count.toLocaleString()),
          h('td', null, u.active ? 'Active' : h('span', { class: 'muted' }, 'Inactive')),
          h('td', null, h('div', { class: 'row' },
            h('button', { class: 'btn small', onclick: () => {
              const e = prompt(`Email for ${u.name}:`, u.email);
              if (e && e !== u.email) patch(u.id, { email: e }, 'Email updated');
            } }, 'Edit email'),
            h('button', { class: 'btn small', onclick: () => {
              const p = prompt(`New password for ${u.name} (min 6):`);
              if (p) patch(u.id, { password: p }, 'Password reset');
            } }, 'Reset password'),
            u.id === ctx.user.id ? null : h('button', { class: 'btn small', onclick: () => patch(u.id, { active: !u.active }, u.active ? 'Deactivated' : 'Activated') }, u.active ? 'Deactivate' : 'Activate'),
            u.id === ctx.user.id ? null : h('button', { class: 'btn small danger', onclick: async () => {
              const n = u.lead_count;
              if (!confirm(`Remove ${u.name}?\n\n${n ? `${n.toLocaleString()} lead(s) assigned to them will become Unassigned.\n` : ''}Their past activity stays in the history. They can no longer log in.`)) return;
              try {
                const r = await api('DELETE', `/api/team/${u.id}`);
                toast(`${u.name} removed${r.unassigned ? ` · ${r.unassigned.toLocaleString()} lead(s) unassigned` : ''}`);
                await reload();
              } catch (e) { toast(e.message, true); }
            } }, 'Remove'))));
      }))));
  }
  await reload();
}
