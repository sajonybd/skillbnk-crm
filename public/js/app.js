import { api, setUnauthorizedHandler } from './api.js';
import { h, setTz, toast, registerPeople } from './util.js';
import * as login from './views/login.js';
import * as leads from './views/leads.js';
import * as analytics from './views/analytics.js';
import { icon } from './icons.js';
import * as importer from './views/import.js';
import * as team from './views/team.js';
import * as trash from './views/trash.js';
import * as meetings from './views/meetings.js';
import * as plan from './views/plan.js';
import * as reports from './views/reports.js';
import * as targets from './views/targets.js';
import * as tasks from './views/tasks.js';

// To add a page: create views/yourpage.js exporting render(root, ctx), then add a line here.
const PAGES = [
  { path: 'plan', label: 'Plan', icon: 'clock', view: plan },
  { path: 'leads', label: 'Leads', icon: 'users', view: leads },
  { path: 'targets', label: 'Targets', icon: 'target', view: targets },
  { path: 'tasks', label: 'Tasks', icon: 'listCheck', view: tasks },
  { path: 'reports', label: 'Reports', icon: 'chart', view: reports },
  { path: 'meetings', label: 'Meetings', icon: 'calendar', view: meetings },
  { path: 'analytics', label: 'Analytics', icon: 'chart', view: analytics },
  { path: 'import', label: 'Import', icon: 'inbox', view: importer },
  { path: 'team', label: 'Team', icon: 'userCheck', view: team, adminOnly: true },
  { path: 'trash', label: 'Recycle bin', icon: 'trash', view: trash, adminOnly: true },
];

const app = document.getElementById('app');
const ctx = { user: null, config: null, users: [], reloadUsers: null };

async function boot() {
  setUnauthorizedHandler(() => { ctx.user = null; showLogin(); });
  try {
    const me = await api('GET', '/api/me');
    ctx.user = me.user;
    ctx.weak = me.weakPassword;
  } catch {
    return showLogin();
  }
  await start();
}

function showLogin() {
  app.className = '';
  login.render(app, async (user, weak) => { ctx.user = user; ctx.weak = weak; await start(); });
}

async function start() {
  ctx.config = await api('GET', '/api/config');
  setTz(ctx.config.tz);
  ctx.reloadUsers = async () => { ctx.users = (await api('GET', '/api/team')).users; registerPeople(ctx.users); };
  await ctx.reloadUsers();
  if (ctx.weak) { toast('You are still using a default password. Click Password (top right) to change it.', true); ctx.weak = false; }
  window.addEventListener('hashchange', route);
  route();
}

async function route() {
  if (!ctx.user) return;
  const path = location.hash.replace(/^#\/?/, '') || 'plan';
  const pages = PAGES.filter((p) => !p.adminOnly || ctx.user.role === 'admin');
  const page = pages.find((p) => p.path === path) || pages[0];

  const main = h('main', { class: 'page' });
  app.className = 'shell';
  app.replaceChildren(topbar(pages, page), main);
  try {
    await page.view.render(main, ctx);
  } catch (e) {
    main.replaceChildren(h('div', { class: 'card empty' }, 'Could not load this page: ' + e.message));
  }
}

function topbar(pages, active) {
  const initials = ctx.user.name.split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  return h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'SB'), h('div', null, h('div', { class: 'brand-name' }, 'skillBNK'), h('div', { class: 'brand-sub' }, 'Outreach CRM'))),
    h('nav', { class: 'nav' }, pages.map((p) => h('a', { href: '#/' + p.path, class: p === active ? 'active' : '' }, icon(p.icon, 18), p.label))),
    h('div', { class: 'spacer' }),
    h('div', { class: 'usercard' },
      h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:10px' }, h('span', { class: 'ua' }, initials), h('div', { style: 'min-width:0' }, h('div', { class: 'un' }, ctx.user.name), h('div', { class: 'ur' }, ctx.user.role === 'admin' ? 'Administrator' : 'Team member'))),
      h('div', { class: 'ulinks' },
        h('button', { onclick: makeToken, title: 'Create a key for scripts or an AI agent' }, 'API key'),
        h('button', { onclick: changePassword }, 'Password'),
        h('button', { onclick: async () => { await api('POST', '/api/logout'); ctx.user = null; showLogin(); } }, 'Sign out'))));
}

async function makeToken() {
  const name = prompt('Name this key (for example "Claude outreach agent"):', 'Claude outreach agent');
  if (name == null) return;
  try {
    const { token } = await api('POST', '/api/me/tokens', { name });
    prompt('Copy this key now. It is shown only once. Send it as "Authorization: Bearer <key>".', token);
  } catch (e) { toast(e.message, true); }
}

async function changePassword() {
  const current = prompt('Current password:');
  if (current == null) return;
  const next = prompt('New password (min 6 characters):');
  if (next == null) return;
  try { await api('POST', '/api/me/password', { current, next }); toast('Password changed'); }
  catch (e) { toast(e.message, true); }
}

boot();
