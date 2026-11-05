import { api } from '../api.js';
import { h } from '../util.js';

export function render(root, onSuccess) {
  const err = h('div', { class: 'error' });
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, autofocus: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', { class: 'card login' },
    h('h1', null, 'skillBNK CRM'),
    h('div', { class: 'muted' }, 'Sign in to manage leads'),
    h('label', null, 'Email'), email,
    h('label', null, 'Password'), pw,
    h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'),
    err,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      const { user, weakPassword } = await api('POST', '/api/login', { email: email.value, password: pw.value });
      onSuccess(user, weakPassword);
    } catch (ex) { err.textContent = ex.message; }
  });
  root.replaceChildren(form);
  email.focus();
}
