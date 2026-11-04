import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

// File paths stay in the host; pages and agents never receive path grants.
export function createBrowserFiles({ dataDir, chooseSave, chooseUpload, changed, downloads, allowed, canPrompt = () => false, prepareNativeDownload = (item, filename) => item.setSaveDialogOptions({ title: 'Save website download', defaultPath: filename }) }) {
  const tickets = new Map(), active = new Map(); let closed = false;
  const name = value => String(value || 'download').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180) || 'download';
  function install(session, findTab) {
    const listener = (event, item, contents) => {
      const tab = findTab(contents), ticket = tickets.get(contents?.id);
      let source;
      try { source = new URL(item.getURL()); if (source.href.length > 8192 || source.username || source.password) throw new Error(); }
      catch { event.preventDefault(); if (tab && allowed(tab)) { tab.tab.error = 'This download URL is unsupported.'; changed(); } return; }
      if (['blob:', 'data:'].includes(source.protocol)) {
        if (!tab || !allowed(tab) || !canPrompt(tab)) { event.preventDefault(); return; }
        const record = { id: randomUUID(), chatId: tab.group.chatId, tabId: tab.tab.id, url: '', transient: true, filename: name(item.getFilename()), status: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes() };
        try { prepareNativeDownload(item, record.filename); } catch { event.preventDefault(); tab.tab.error = 'The native download dialog is unavailable.'; changed(); return; }
        downloads.unshift(record); downloads.length = Math.min(downloads.length, 100); active.set(record.id, item); changed();
        item.on('updated', (_event, status) => { record.status = status; record.receivedBytes = item.getReceivedBytes(); record.totalBytes = item.getTotalBytes(); changed(); });
        item.once('done', (_event, status) => { record.status = status; record.receivedBytes = item.getReceivedBytes(); active.delete(record.id); changed(); });
        return;
      }
      if (!['http:', 'https:'].includes(source.protocol)) { event.preventDefault(); return; }
      const chain = item.getURLChain?.() || [item.getURL()];
      const permitted = ticket?.agent ? tab?.group.mode === 'agent' && !ticket.signal?.aborted : tab && allowed(tab);
      if (!tab || !permitted || !ticket || ticket.epoch !== tab.group.epoch || ticket.expires < Date.now() || !chain.includes(ticket.url)) {
        event.preventDefault();
        if (tab && allowed(tab)) { downloads.unshift({ id: randomUUID(), chatId: tab.group.chatId, tabId: tab.tab.id, url: source.href, filename: name(item.getFilename()), status: 'pending', receivedBytes: 0, totalBytes: item.getTotalBytes() }); downloads.length = Math.min(downloads.length, 100); changed(); }
        return;
      }
      tickets.delete(contents.id); item.setSavePath(ticket.path);
      ticket.item = item;
      const record = { id: randomUUID(), chatId: tab.group.chatId, tabId: tab.tab.id, url: ticket.url, filename: path.basename(ticket.path), status: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes() };
      downloads.unshift(record); downloads.length = Math.min(downloads.length, 100); active.set(record.id, item); changed();
      item.on('updated', (_event, status) => { record.status = status; record.receivedBytes = item.getReceivedBytes(); record.totalBytes = item.getTotalBytes(); if (ticket.agent && (record.receivedBytes > 64 * 1024 * 1024 || record.totalBytes > 64 * 1024 * 1024 || tab.group.mode !== 'agent' || tab.group.epoch !== ticket.epoch)) { item.cancel(); ticket.finish?.(new Error('Agent download exceeded its limit or browser control changed.')); } changed(); });
      item.once('done', (_event, status) => { record.status = status; record.receivedBytes = item.getReceivedBytes(); active.delete(record.id); changed(); ticket.finish?.(status === 'completed' && (!ticket.agent || record.receivedBytes <= 64 * 1024 * 1024) ? null : new Error(`Browser download ${status === 'completed' ? 'exceeded 64 MiB' : status}.`), { id: record.id, path: ticket.path, filename: record.filename, bytes: record.receivedBytes, url: ticket.url }); });
      if (ticket.agent && item.getTotalBytes() > 64 * 1024 * 1024) { item.cancel(); ticket.finish?.(new Error('Agent downloads are limited to 64 MiB.')); }
    };
    session.on('will-download', listener); return () => session.removeListener('will-download', listener);
  }
  return {
    install,
    async agentDownload(tab, url, signal) {
      signal?.throwIfAborted();
      if (closed || tab.group.mode !== 'agent' || !dataDir) throw new Error('Agent downloads are unavailable during human control.');
      const directory = path.join(dataDir, 'browser-downloads'); await fs.mkdir(directory, { recursive: true });
      if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Browser download directory must not be a link.');
      const realDirectory = await fs.realpath(directory), target = path.join(realDirectory, randomUUID() + '-' + name(new URL(url).pathname.split('/').pop()));
      try { await fs.lstat(target); throw new Error('Browser download destination already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      signal?.throwIfAborted(); const epoch = tab.group.epoch;
      return new Promise((resolve, reject) => {
        const ticket = { agent: true, url, path: target, epoch, signal, expires: Date.now() + 60000 }; let done = false;
        const abort = () => { ticket.item?.cancel(); ticket.finish(signal.reason || new Error('Agent download canceled.')); };
        const timer = setTimeout(() => { ticket.item?.cancel(); ticket.finish(new Error('Agent download timed out.')); }, 60000); timer.unref?.();
        ticket.finish = (error, value) => {
          if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (tickets.get(tab.contents.id) === ticket) tickets.delete(tab.contents.id);
          if (error) { void fs.rm(target, { force: true }); reject(error); } else resolve(value);
        };
        signal?.addEventListener('abort', abort, { once: true }); tickets.set(tab.contents.id, ticket); tab.contents.downloadURL(url);
      });
    },
    async download(tab, url) {
      if (closed || !allowed(tab)) throw new Error('Take control of this browser before downloading a file.');
      const epoch = tab.group.epoch, pending = downloads.find(record => record.status === 'pending' && record.chatId === tab.group.chatId && record.tabId === tab.tab.id && record.url === url);
      const target = await chooseSave?.(name(pending?.filename || new URL(url).pathname.split('/').pop()));
      if (!target) return { canceled: true };
      if (!path.isAbsolute(target) || target.includes('\0')) throw new Error('Choose an absolute download destination.');
      if (closed || !allowed(tab) || tab.group.epoch !== epoch) throw new Error('Browser ownership changed while choosing the destination.');
      tickets.set(tab.contents.id, { url, path: target, epoch, expires: Date.now() + 30000 });
      tab.contents.downloadURL(url);
      const index = pending ? downloads.indexOf(pending) : -1; if (index >= 0) { downloads.splice(index, 1); changed(); }
      return { started: true };
    },
    async upload(tab, params, command) {
      if (closed || !allowed(tab)) throw new Error('Take control of this browser before uploading a file.');
      const epoch = tab.group.epoch, revision = tab.revision;
      const paths = await chooseUpload?.(params.mode === 'selectMultiple');
      if (!paths?.length) return { canceled: true };
      if (paths.length > 32 || paths.some(value => typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))) throw new Error('Choose up to 32 local files.');
      if (closed || !allowed(tab) || tab.group.epoch !== epoch || tab.revision !== revision) throw new Error('Browser page or ownership changed while choosing files.');
      await command('DOM.setFileInputFiles', { backendNodeId: params.backendNodeId, files: paths });
      return { uploaded: paths.length };
    },
    cancel(id) { const item = active.get(id); if (!item) throw new Error('This download is no longer active.'); item.cancel(); return { canceled: true }; },
    close() { closed = true; for (const ticket of tickets.values()) ticket.finish?.(new Error('Browser downloads closed.')); tickets.clear(); for (const item of active.values()) item.cancel(); active.clear(); },
  };
}
