export type OutputStatus =
  | 'success'
  | 'error'
  | 'warning'
  | 'info';

const ICONS: Record<OutputStatus, string> = {
  success: '✓',
  error: '✕',
  warning: '!',
  info: '•',
};

export function box(
  title: string,
  lines: string[] = [],
  status?: OutputStatus,
): string {
  const icon = status ? `${ICONS[status]} ` : '';

  return [
    `╭━━━ ${icon}${title} ━━━╮`,
    '┃',
    ...lines.map(line => `┃ ${line}`),
    '┃',
    '╰━━━━━━━━━━━━━━━━━━━━━━╯',
  ].join('\n');
}

export function success(
  title: string,
  lines: string[] = [],
): string {
  return box(title, lines, 'success');
}

export function error(
  title: string,
  lines: string[] = [],
): string {
  return box(title, lines, 'error');
}

export function warning(
  title: string,
  lines: string[] = [],
): string {
  return box(title, lines, 'warning');
}

export function info(
  title: string,
  lines: string[] = [],
): string {
  return box(title, lines, 'info');
}

export function divider(): string {
  return '━━━━━━━━━━━━━━━━━━━━━━';
}

export function section(title: string): string {
  return `\n── ${title} ──`;
}

export function kv(
  key: string,
  value: string | number | boolean,
): string {
  return `${key.padEnd(10)}: ${value}`;
}
