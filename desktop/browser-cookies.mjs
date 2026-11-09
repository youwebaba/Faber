// Chromium persists expiring cookies; encrypted host storage restores session cookies too.
export async function rememberSessionCookies(session, key, { read, write, onError = () => {} }) {
  if (!read || !write) return { close: async () => {} };
  const saved = await read(key); let values = saved ? JSON.parse(saved) : [];
  if (!Array.isArray(values) || values.length > 2000 || JSON.stringify(values).length > 2 * 1024 * 1024) throw new Error('Invalid encrypted browser session-cookie store.');
  const current = await session.cookies.get({}), identity = cookie => `${cookie.domain}\n${cookie.path}\n${cookie.name}`;
  const existing = new Set(current.map(identity));
  for (const cookie of values) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string' || cookie.name.length > 4096 || cookie.value.length > 16384 || !/^\.?[a-zA-Z0-9_.:[\]-]+$/.test(cookie.domain) || typeof cookie.path !== 'string' || !cookie.path.startsWith('/')) throw new Error('Invalid saved browser session cookie.');
    if (existing.has(identity(cookie))) continue;
    const { name, value, path, secure, httpOnly, sameSite } = cookie;
    const host = cookie.domain.replace(/^\./, '');
    await session.cookies.set({ url: `${secure ? 'https' : 'http'}://${host}${path}`, name, value, path, secure, httpOnly, sameSite, ...(!cookie.hostOnly ? { domain: cookie.domain } : {}) });
  }
  let pending, dirty = false, closing, lastEncoded = saved;
  function save() {
    dirty = true;
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        while (dirty) {
          dirty = false;
          const cookies = await session.cookies.get({ session: true });
          values = cookies.map(({ name, value, domain, hostOnly, path, secure, httpOnly, sameSite }) => ({ name, value, domain, hostOnly, path, secure, httpOnly, sameSite }));
          const encoded = JSON.stringify(values);
          if (values.length > 2000 || encoded.length > 2 * 1024 * 1024) throw new Error('Browser session-cookie storage limit exceeded.');
          if (encoded !== lastEncoded) { await write(key, encoded); lastEncoded = encoded; }
        }
      }).finally(() => { pending = undefined; if (dirty) save(); });
      pending.catch(() => onError(new Error('Browser session sign-ins could not be saved securely.')));
    }
    return pending;
  }
  const changed = () => { void save(); };
  session.cookies.on('changed', changed);
  return { close() {
    if (!closing) {
      session.cookies.removeListener('changed', changed);
      closing = (async () => { await save(); while (pending) await pending; })();
    }
    return closing;
  } };
}
