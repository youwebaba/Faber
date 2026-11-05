import { isActive } from './ui-helpers.mjs';

export function orderedChatFamilies(state, projectId) {
  const chats = state.chats.filter(chat => chat.projectId === projectId && !chat.archived);
  const byId = new Map(chats.map(chat => [chat.id, chat]));
  const activity = new Map(chats.map(chat => [chat.id, chat.messages?.findLast(message => message.role === 'assistant' && !message.fromChatId)?.createdAt || chat.lastAssistantAt || chat.createdAt || '']));
  const compare = (a, b) => String(activity.get(b.id)).localeCompare(String(activity.get(a.id))) || String(a.id).localeCompare(String(b.id));
  const children = new Map();
  for (const chat of chats) {
    const parent = byId.has(chat.parentChatId) && chat.parentChatId !== chat.id ? chat.parentChatId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(chat);
  }
  const result = [], visited = new Set();
  function append(chat, depth) {
    if (visited.has(chat.id)) return;
    visited.add(chat.id); result.push({ chat, depth });
    for (const child of (children.get(chat.id) || []).sort(compare)) append(child, depth + 1);
  }
  for (const chat of (children.get(null) || []).sort(compare)) append(chat, 0);
  // Keep malformed historical cycles visible without letting them recurse forever.
  for (const chat of [...chats].sort(compare)) if (!visited.has(chat.id)) append(chat, 0);
  return result;
}

export function chatFamily(state, chatId) {
  const ids = new Set([chatId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const chat of state.chats) if (ids.has(chat.parentChatId) && !ids.has(chat.id)) { ids.add(chat.id); changed = true; }
  }
  return ids;
}
export function navigationActions(state, kind, id) {
  if (kind === 'project') return state.projects.some(item => item.id === id && !item.archived) ? [
    { id: 'archive', label: 'Archive project' }, { id: 'delete', label: 'Delete project', danger: true },
  ] : [];
  if (!state.chats.some(item => item.id === id && !item.archived)) return [];
  const family = chatFamily(state, id), running = state.runs.some(run => family.has(run.chatId) && isActive(run));
  return [
    { id: 'move', label: 'Move to project…', disabled: running },
    { id: 'archive', label: 'Archive chat' },
    { id: 'forceStop', label: 'Force stop', disabled: !running },
    { id: 'delete', label: 'Delete chat', danger: true },
  ];
}
export function deletionWarning(kind) {
  if (!['chat', 'project'].includes(kind)) throw new Error('Unknown deletion target.');
  return `Are you sure you want to delete this ${kind}? Deleted chats are not recoverable!`;
}

export function createNavigationMenu({ el, getState, onAction }) {
  const menu = el('div', 'chat-context-menu'); menu.id = 'chat-context-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true; document.body.append(menu);
  let target, returnFocus;
  function close(focus = false) { menu.hidden = true; target = undefined; if (focus) returnFocus?.(); }
  function open(event, kind, id, origin) {
    event.preventDefault(); event.stopPropagation();
    const items = navigationActions(getState(), kind, id); if (!items.length) return;
    close(); target = { kind, id }; menu.replaceChildren(); menu.setAttribute('aria-label', `${kind === 'chat' ? 'Chat' : 'Project'} options`);
    returnFocus = () => { const key = kind === 'chat' ? 'chatId' : 'projectId'; const current = [...document.querySelectorAll(`[data-${kind}-id]`)].find(node => node.dataset[key] === id); (current || (origin.isConnected ? origin : document.querySelector('#new-chat')))?.focus(); };
    for (const item of items) {
      const action = el('button', item.danger ? 'danger' : '', item.label); action.type = 'button'; action.setAttribute('role', 'menuitem'); action.dataset.action = item.id; action.disabled = Boolean(item.disabled);
      if (item.disabled && item.id === 'move') action.title = 'Stop this chat and its child agents before moving it.';
      action.addEventListener('click', () => { const selected = target; if (!selected) return; close(); onAction(selected.kind, selected.id, item.id, returnFocus); }); menu.append(action);
    }
    menu.hidden = false;
    const bounds = origin.getBoundingClientRect(), keyboard = event.type === 'keydown' || (!event.clientX && !event.clientY);
    menu.style.left = `${Math.max(8, Math.min(keyboard ? bounds.left + 16 : event.clientX, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(keyboard ? bounds.bottom : event.clientY, innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    const entries = [...menu.querySelectorAll('button:not(:disabled)')], index = entries.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length; entries[next]?.focus(); }
    if (event.key === 'Tab') close();
  });
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target)) close(); });
  window.addEventListener('resize', () => close());
  return { close, isOpen: () => !menu.hidden,
    bind(node, kind, id) {
      node.dataset[kind === 'chat' ? 'chatId' : 'projectId'] = id; node.setAttribute('aria-haspopup', 'menu');
      node.addEventListener('contextmenu', event => open(event, kind, id, node));
      node.addEventListener('keydown', event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) open(event, kind, id, node); });
    },
  };
}
