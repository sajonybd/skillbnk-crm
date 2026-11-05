// Builds the key used to detect duplicate leads.
// Priority: email → LinkedIn profile → first+last+company.

export function normLinkedIn(url) {
  const s = String(url || '').trim().toLowerCase();
  if (!s) return '';
  const m = s.match(/linkedin\.com\/(.*)$/);
  const tail = (m ? m[1] : s).split(/[?#]/)[0].replace(/\/+$/, '');
  return tail;
}

export function dedupeKey(l) {
  const email = String(l.email || '').trim().toLowerCase();
  if (email) return 'e:' + email;
  const li = normLinkedIn(l.linkedin);
  if (li) return 'l:' + li;
  const name = [l.first_name, l.last_name, l.company]
    .map((x) => String(x || '').trim().toLowerCase())
    .join('|');
  return 'n:' + name;
}

export function hasIdentity(l) {
  return Boolean(
    String(l.email || '').trim() ||
      String(l.linkedin || '').trim() ||
      String(l.first_name || '').trim() ||
      String(l.last_name || '').trim()
  );
}

// Finds a lead that is already in the CRM, however it was entered: same email, same LinkedIn profile,
// or same first+last name at the same company. Catches the case where one copy has only an email and
// the other only a LinkedIn link (their stored dedupe keys differ). Returns the row or null.
// Active leads win over ones in the recycle bin.
export function findExisting(db, l) {
  const email = String(l.email || '').trim().toLowerCase();
  const li = normLinkedIn(l.linkedin);
  const f = String(l.first_name || '').trim().toLowerCase();
  const la = String(l.last_name || '').trim().toLowerCase();
  const co = String(l.company || '').trim().toLowerCase();
  const found = [];
  if (email) found.push(...db.prepare('SELECT * FROM leads WHERE LOWER(email) = ?').all(email));
  if (li) {
    const slug = li.split('/').filter(Boolean).pop() || li;
    for (const r of db.prepare("SELECT * FROM leads WHERE linkedin != '' AND LOWER(linkedin) LIKE ?").all(`%${slug}%`)) {
      if (normLinkedIn(r.linkedin) === li) found.push(r);
    }
  }
  if (f && la) found.push(...db.prepare('SELECT * FROM leads WHERE LOWER(first_name) = ? AND LOWER(last_name) = ? AND LOWER(company) = ?').all(f, la, co));
  found.sort((a, b) => (a.deleted_at ? 1 : 0) - (b.deleted_at ? 1 : 0) || a.id - b.id);
  return found[0] || null;
}
