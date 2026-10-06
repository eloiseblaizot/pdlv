import fs from 'node:fs';
import path from 'node:path';

let stream = null;

export function initLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'launcher.log');
  // Garde une seule génération précédente pour ne pas remplir le disque.
  if (fs.existsSync(file)) fs.renameSync(file, path.join(dir, 'launcher.old.log'));
  stream = fs.createWriteStream(file, { flags: 'a' });
}

function write(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  stream?.write(line + '\n');
}

export const log = {
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
};
