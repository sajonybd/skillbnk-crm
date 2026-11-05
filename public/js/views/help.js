import { api } from '../api.js';
import { h, toast } from '../util.js';
import { renderMd } from './reports.js';

const state = { tab: 'team' };

export async function render(root) {
  const docs = await api('GET', '/api/playbook/docs');
  const tabs = h('div', { class: 'seg' });
  const body = h('div');
  root.replaceChildren(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Help'), h('div', { class: 'muted' }, 'How the CRM works, and how an AI agent can use it.')), h('div', { class: 'spacer' }), tabs), body);

  function draw() {
    tabs.replaceChildren(
      h('button', { class: 'segb' + (state.tab === 'team' ? ' on' : ''), onclick: () => { state.tab = 'team'; draw(); } }, 'User guide'),
      h('button', { class: 'segb' + (state.tab === 'agent' ? ' on' : ''), onclick: () => { state.tab = 'agent'; draw(); } }, 'AI agent & API'));
    const md = state.tab === 'team' ? docs.team : docs.agent;
    const copy = state.tab === 'agent' ? h('div', { class: 'rep-bar' }, h('button', { class: 'btn primary', onclick: async () => {
      try { await navigator.clipboard.writeText(md); toast('Copied. Give it to your AI agent.'); } catch { toast('Could not copy. Select the text instead.', true); }
    } }, 'Copy this guide for my AI agent')) : null;
    body.replaceChildren(...[copy, renderMd(md || 'The guide is not available on this server.')].filter(Boolean));
  }
  draw();
}
