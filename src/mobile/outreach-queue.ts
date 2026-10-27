import fs from 'node:fs';
import path from 'node:path';
import type makeWASocket from '@whiskeysockets/baileys';

type Socket = ReturnType<typeof makeWASocket>;

type QueueJob = {
  id: string;
  phone: string;
  text: string;
  contactKey: string;
  supplier?: string;
  listing?: string;
};

export function createOutreachQueue(deps: {
  getSocket: () => Socket | null;
  isConnected: () => boolean;
  reportError: (where: string, error: unknown) => unknown;
}) {
  const base = process.env.MOTORCYCLE_LEADS_DIR ||
    path.join(process.env.HOME || '.', 'motorcycle-leads');
  const queueDir = path.join(base, 'whatsapp-queue');
  const resultDir = path.join(base, 'outreach-results');
  const stopFile = path.join(base, 'STOP_OUTREACH');

  let running = false;
  let sendingEnabled = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reviewedFiles: Set<string> | null = null;

  function ensureDirs() {
    fs.mkdirSync(queueDir, { recursive: true });
    fs.mkdirSync(resultDir, { recursive: true });
  }

  function queueFiles(): string[] {
    ensureDirs();
    return fs.readdirSync(queueDir)
      .filter(name => /^[a-f0-9]{32}\.json$/i.test(name))
      .sort();
  }

  function readJob(name: string): QueueJob {
    return JSON.parse(
      fs.readFileSync(path.join(queueDir, name), 'utf8'),
    ) as QueueJob;
  }

  function result(job: QueueJob, status: string, detail = '') {
    const destination = path.join(resultDir, `${job.id}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;

    fs.writeFileSync(temporary, JSON.stringify({
      id: job.id,
      contactKey: job.contactKey,
      channel: 'whatsapp',
      status,
      detail: detail.slice(0, 500),
      updatedAt: new Date().toISOString(),
    }) + '\n', { mode: 0o600 });

    fs.renameSync(temporary, destination);
  }

  function readQueue(page = 1): string {
    const files = queueFiles();
    const pageSize = 3;
    const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
    const selectedPage = Number.isFinite(page)
      ? Math.max(1, Math.min(totalPages, Math.floor(page)))
      : 1;

    const start = (selectedPage - 1) * pageSize;
    const selected = files.slice(start, start + pageSize);

    const lines = [
      `OUTREACH QUEUE — ${files.length} queued`,
      `Page ${selectedPage}/${totalPages}`,
      `Delivery: ${sendingEnabled ? 'ENABLED' : 'PAUSED'}`,
      '',
    ];

    if (stopFileExists()) {
      lines.push('EMERGENCY STOP FILE EXISTS.');
      lines.push('');
    }

    if (!selected.length) {
      lines.push('No queued messages.');
      return lines.join('\n');
    }

    for (let i = 0; i < selected.length; i++) {
      try {
        const job = readJob(selected[i]);
        lines.push(`${start + i + 1}. ${job.supplier || 'Supplier'}`);
        lines.push(`Phone: ${job.phone}`);
        if (job.listing) lines.push(`Listing: ${job.listing}`);
        lines.push('Message:');
        lines.push(job.text || '(empty message)');
        lines.push('');
      } catch (err) {
        lines.push(`${start + i + 1}. Cannot read ${selected[i]}`);
        lines.push(String(err));
        lines.push('');
      }
    }

    if (totalPages > 1) {
      lines.push(`Next page: !outreach queue ${selectedPage + 1}`);
    }

    return lines.join('\n').slice(0, 12000);
  }

  function stopFileExists(): boolean {
    return fs.existsSync(stopFile);
  }

  function dedupe(): string {
    ensureDirs();
    sendingEnabled = false;

    const seenPhones = new Set<string>();
    let duplicates = 0;
    let invalid = 0;

    for (const name of queueFiles()) {
      const source = path.join(queueDir, name);

      try {
        const job = readJob(name);
        const phone = String(job.phone || '').replace(/\D/g, '');

        if (
          !job.id ||
          !/^[0-9]{10,15}$/.test(phone) ||
          typeof job.text !== 'string' ||
          !job.text.trim() ||
          !job.contactKey
        ) {
          fs.renameSync(source, `${source}.invalid`);
          invalid++;
          continue;
        }

        if (seenPhones.has(phone)) {
          fs.renameSync(source, `${source}.duplicate`);
          duplicates++;
          continue;
        }

        seenPhones.add(phone);
      } catch {
        try {
          fs.renameSync(source, `${source}.invalid`);
          invalid++;
        } catch {
          // Leave the file untouched if it cannot be moved.
        }
      }
    }

    reviewedFiles = new Set(queueFiles());

    return [
      'OUTREACH DEDUPLICATION COMPLETE',
      `Unique queued contacts: ${reviewedFiles.size}`,
      `Duplicate jobs quarantined: ${duplicates}`,
      `Invalid jobs quarantined: ${invalid}`,
      '',
      'Delivery remains paused.',
      'Review with !outreach queue',
      'Send with !outreach send',
    ].join('\n');
  }

  function status(): string {
    const names = fs.existsSync(queueDir)
      ? fs.readdirSync(queueDir)
      : [];

    const count = (suffix: string) =>
      names.filter(name => name.endsWith(suffix)).length;

    return [
      'OUTREACH STATUS',
      `Queued: ${names.filter(n => /^[a-f0-9]{32}\.json$/i.test(n)).length}`,
      `Processing: ${count('.processing')}`,
      `Sent: ${count('.done')}`,
      `Failed/uncertain: ${count('.failed')}`,
      `Duplicates quarantined: ${count('.duplicate')}`,
      `Invalid quarantined: ${count('.invalid')}`,
      `Delivery: ${sendingEnabled ? 'ENABLED' : 'PAUSED'}`,
      `Emergency stop: ${stopFileExists() ? 'ACTIVE' : 'not present'}`,
      `Deduplication review: ${reviewedFiles ? 'available' : 'required'}`,
    ].join('\n');
  }

  function stop(): string {
    ensureDirs();
    sendingEnabled = false;
    reviewedFiles = null;

    fs.writeFileSync(stopFile, `Stopped at ${new Date().toISOString()}\n`, {
      mode: 0o600,
    });

    return 'OUTREACH STOPPED. Queued jobs are paused. Run !outreach resume, review with !outreach dedupe, then !outreach send to resume.';
  }

  function resume(): string {
    if (stopFileExists()) fs.unlinkSync(stopFile);

    sendingEnabled = false;
    reviewedFiles = null;

    return 'Emergency stop cleared. Delivery remains PAUSED. Run !outreach dedupe, review the queue, then !outreach send.';
  }

  function send(): string {
    if (stopFileExists()) {
      return 'SEND BLOCKED: emergency stop is active. Run !outreach resume, then !outreach dedupe and review before sending.';
    }

    if (!reviewedFiles) {
      return 'SEND BLOCKED: run !outreach dedupe and review the queue first.';
    }

    const current = queueFiles();
    const same =
      current.length === reviewedFiles.size &&
      current.every(name => reviewedFiles!.has(name));

    if (!same) {
      reviewedFiles = null;
      return 'SEND BLOCKED: queue changed after review. Run !outreach dedupe and inspect it again.';
    }

    if (!current.length) return 'No queued messages to send.';

    sendingEnabled = true;
    void drain();

    return `Sending enabled for ${current.length} reviewed jobs only. Use !outreach stop to pause delivery.`;
  }

  async function drain() {
    if (
      running ||
      !sendingEnabled ||
      stopFileExists() ||
      !deps.isConnected()
    ) return;

    const sock = deps.getSocket();
    if (!sock) return;

    running = true;

    try {
      for (const name of queueFiles()) {
        if (
          !sendingEnabled ||
          stopFileExists() ||
          !deps.isConnected()
        ) break;

        if (!reviewedFiles?.has(name)) continue;

        const source = path.join(queueDir, name);
        const claimed = path.join(queueDir, name + '.processing');

        try {
          fs.renameSync(source, claimed);
        } catch {
          continue;
        }

        let job: QueueJob | undefined;

        try {
          job = JSON.parse(fs.readFileSync(claimed, 'utf8')) as QueueJob;

          if (
            !job.id ||
            !/^[0-9]{10,15}$/.test(job.phone) ||
            typeof job.text !== 'string' ||
            !job.text.trim() ||
            !job.contactKey
          ) {
            throw new Error('Invalid queue job');
          }

          // Recheck the emergency stop immediately before transmission.
          if (
            !sendingEnabled ||
            stopFileExists() ||
            !deps.isConnected()
          ) {
            try {
              fs.renameSync(claimed, source);
            } catch {}
            sendingEnabled = false;
            break;
          }

          await sock.sendMessage(`${job.phone}@s.whatsapp.net`, {
            text: job.text,
          });

          result(job, 'sent');
          fs.renameSync(claimed, path.join(queueDir, name + '.done'));
          reviewedFiles?.delete(name);
          console.log(`[OUTREACH] WhatsApp sent; job=${job.id}`);
        } catch (err) {
          if (job) {
            try {
              result(
                job,
                'failed_or_uncertain',
                err instanceof Error ? err.message : String(err),
              );
            } catch {}
          }

          try {
            fs.renameSync(claimed, path.join(queueDir, name + '.failed'));
          } catch {}

          reviewedFiles?.delete(name);

          console.error(
            `[OUTREACH] Job failed; no automatic retry: ${name}`,
            err instanceof Error ? err.message : String(err),
          );
          void deps.reportError('outreach-whatsapp', err);
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    } catch (err) {
      console.error('[OUTREACH] Queue scan failed:', err);
      void deps.reportError('outreach-queue', err);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      ensureDirs();
      sendingEnabled = false;
      reviewedFiles = null;
      timer = setInterval(() => { void drain(); }, 5000);
      timer.unref();
      console.log(`[OUTREACH] WhatsApp queue enabled but PAUSED: ${queueDir}`);
    },
    readQueue,
    dedupe,
    status,
    stop,
    resume,
    send,
  };
}
