import { parentPort } from 'node:worker_threads';

import {
  scanText,
  saveMatches,
  savePayloadRecord,
} from './scanner.js';

type ScanJob = {
  id: number;
  text: string;
  source: string;
  chat: string;
  sender: string;
};

if (!parentPort) {
  throw new Error('Scanner worker requires parentPort');
}

parentPort.on('message', (job: ScanJob) => {
  try {
    const matches = scanText(
      job.text,
      job.source,
      job.chat,
      job.sender,
    );

    const fresh = saveMatches(matches);

    if (
      job.source.toLowerCase().includes('decrypted')
    ) {
      try {
        savePayloadRecord(
          job.text,
          job.source,
          job.chat,
          job.sender,
        );
      } catch (error) {
        console.error(
          '[SCANNER WORKER] payload record failed:',
          error,
        );
      }
    }

    parentPort!.postMessage({
      id: job.id,
      ok: true,
      fresh,
    });
  } catch (error) {
    parentPort!.postMessage({
      id: job.id,
      ok: false,
      error:
        error instanceof Error
          ? error.stack || error.message
          : String(error),
    });
  }
});
