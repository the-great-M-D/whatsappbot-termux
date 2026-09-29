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

function identityVariants(value: unknown): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const out = new Set<string>();
  out.add(raw);

  const number = raw
    .split('@')[0]
    .split(':')[0]
    .replace(/[^0-9]/g, '');

  if (number) {
    out.add(number);
    out.add(number + '@s.whatsapp.net');
  }

  return [...out];
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
  const senderIds = new Set(identityVariants(jid));

  return meta.participants.some((p: any) => {
    if (
      p.admin !== 'admin' &&
      p.admin !== 'superadmin'
    ) {
      return false;
    }

    const participantIds = [
      p.id,
      p.lid,
      p.phoneNumber,
      p.jid,
    ].flatMap(identityVariants);

    const matched = participantIds.some(id => senderIds.has(id));

    if (matched) {
      console.log(
        '[MOD] admin match:',
        jid,
        '=>',
        p.id,
        p.lid || '',
        p.phoneNumber || '',
      );
    }

    return matched;
  });
}

export async function moderate(
  sock: WASocket,
  M: any,
  cmd: string,
  arg: string,
) {
  const chat = chatJid(M);

  if (!chat.endsWith('@g.us')) {
    return void M.reply('Group only.');
  }

  const meta = await sock.groupMetadata(chat);
  const sender = senderJid(M);

  if (!isAdmin(meta, sender)) {
    console.log(
      '[MOD] admin check failed:',
      'sender=', sender,
      'group=', chat,
      'admins=',
      meta.participants
        .filter((p: any) => p.admin === 'admin' || p.admin === 'superadmin')
        .map((p: any) => ({
          id: p.id,
          lid: p.lid || '',
          phoneNumber: p.phoneNumber || '',
          admin: p.admin,
        })),
    );

    return void M.reply('Admin only.');
  }

  const bot = sock.user?.id || '';

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
