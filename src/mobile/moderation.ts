import type { WASocket, GroupMetadata } from '@whiskeysockets/baileys';
import { loadState, saveState, type ModState } from './state.js';

export function jidOf(v: string) {
  const n = v.replace(/[^0-9]/g, '');
  return n ? n + '@s.whatsapp.net' : '';
}

function chatJid(M: any): string {
  return String(M.chat || M.key?.remoteJid || '');
}

function senderJid(M: any): string {
  return String(
    M.sender ||
    M.key?.participant ||
    M.key?.remoteJid ||
    '',
  );
}

function isGroupMessage(M: any): boolean {
  return chatJid(M).endsWith('@g.us');
}

export function target(M: any): string {
  return (
    M.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
    M.message?.extendedTextMessage?.contextInfo?.participant ||
    M.key?.participant ||
    ''
  );
}

export function isAdmin(meta: GroupMetadata, jid: string) {
  return meta.participants.some(
    (p: any) =>
      p.id === jid &&
      (p.admin === 'admin' || p.admin === 'superadmin'),
  );
}

export async function moderate(
  sock: WASocket,
  M: any,
  cmd: string,
  arg: string,
) {
  const chat = chatJid(M);

  // Baileys does not guarantee a custom M.isGroup property.
  // Detect groups from the WhatsApp JID instead.
  if (!chat.endsWith('@g.us')) {
    return void M.reply('Group only.');
  }

  const meta = await sock.groupMetadata(chat);
  const sender = senderJid(M);

  if (!isAdmin(meta, sender)) {
    return void M.reply('Admin only.');
  }

  const bot = sock.user?.id
    ? sock.user.id.split(':')[0].split('@')[0] + '@s.whatsapp.net'
    : '';

  if (!isAdmin(meta, bot)) {
    return void M.reply('M_D TOOL must be a group admin.');
  }

  const t = target(M) || jidOf(arg);

  if (!t) {
    return void M.reply('Reply to a user or @mention them.');
  }

  if (isAdmin(meta, t)) {
    return void M.reply('I will not moderate a group admin.');
  }

  const s: ModState = loadState();
  const list = s.muted[chat] || [];

  if (cmd === 'mute') {
    if (!list.includes(t)) list.push(t);
    s.muted[chat] = list;
    saveState(s);
    return void M.reply('Muted.');
  }

  if (cmd === 'unmute') {
    s.muted[chat] = list.filter(x => x !== t);
    saveState(s);
    return void M.reply('Unmuted.');
  }

  if (cmd === 'warnings') {
    return void M.reply(
      'Warnings: ' + (s.warnings[chat + ':' + t] || 0) + '/3',
    );
  }

  if (cmd === 'clearwarn') {
    delete s.warnings[chat + ':' + t];
    saveState(s);
    return void M.reply('Warnings cleared.');
  }

  if (cmd === 'warn') {
    const k = chat + ':' + t;
    const count = (s.warnings[k] || 0) + 1;

    if (count >= 3) {
      delete s.warnings[k];
      saveState(s);
      await sock.groupParticipantsUpdate(chat, [t], 'remove');
      return void M.reply(
        '3/3 warnings — user kicked and warnings reset.',
      );
    }

    s.warnings[k] = count;
    saveState(s);
    return void M.reply('Warning ' + count + '/3.');
  }

  if (cmd === 'kick') {
    await sock.groupParticipantsUpdate(
      chat,
      [t],
      'remove',
    );
    return void M.reply('User kicked.');
  }
}

export async function enforceMute(
  sock: WASocket,
  M: any,
): Promise<boolean> {
  const chat = chatJid(M);

  if (!chat.endsWith('@g.us')) {
    return false;
  }

  const s = loadState();

  if (!(s.muted[chat] || []).includes(senderJid(M))) {
    return false;
  }

  try {
    await sock.sendMessage(chat, {
      delete: M.key,
    });
  } catch (e) {
    console.error('[MUTE]', e);
  }

  return true;
}
