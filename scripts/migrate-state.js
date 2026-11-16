'use strict';
// Offline copy only. Never loads an engine, copies .env, or overwrites existing data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = fs.realpathSync(path.resolve(__dirname, '..'));
const manifest = require('../system.json');
const args = process.argv.slice(2);
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function validate(rel, value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid JSON archive: ' + rel);
  if (rel === 'spotDcaData.json' && (!value.config || !value.positions ||
      !value.positions.long || !value.positions.short)) {
    throw new Error('SmartDCA archive is missing config or positions');
  }
  if (rel.endsWith('weighted_funding.json') && (![1, 2].includes(value.version) ||
      !Array.isArray(value.history1h) || !Array.isArray(value.history8h))) {
    throw new Error('Unknown weighted funding archive format');
  }
}

function main() {
  const idx = args.indexOf('--from');
  if (idx < 0 || !args[idx + 1]) {
    throw new Error('Usage: node scripts/migrate-state.js --from /absolute/old-project [--apply --source-stopped]');
  }
  if (!path.isAbsolute(args[idx + 1])) throw new Error('--from must be absolute');
  const source = fs.realpathSync(args[idx + 1]);
  if (source === root) throw new Error('Source and target must be different');
  const apply = args.includes('--apply');
  if (apply && !args.includes('--source-stopped')) {
    throw new Error('Stop the old writer first, then explicitly pass --source-stopped');
  }
  if (fs.existsSync(path.join(root, '.instance.lock'))) throw new Error('Target is running or has a lock; do not migrate');
  const files = [];
  for (const rel of manifest.data) {
    const from = path.join(source, rel);
    const to = path.join(root, rel);
    if (!fs.existsSync(from)) {
      console.log('MISSING (not copied): ' + rel);
      continue;
    }
    if (!fs.realpathSync(from).startsWith(source + path.sep)) throw new Error('External source symlink: ' + rel);
    if (fs.existsSync(to)) throw new Error('Refusing to overwrite target: ' + rel);
    let ancestor = path.dirname(to);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const realAncestor = fs.realpathSync(ancestor);
    if (realAncestor !== root && !realAncestor.startsWith(root + path.sep)) throw new Error('External target symlink');
    const data = fs.readFileSync(from);
    validate(rel, JSON.parse(data.toString('utf8')));
    files.push({ rel, from, to, data, sha256: hash(data) });
  }
  if (apply && !files.length && manifest.data.length) throw new Error('No source archives found; nothing migrated');
  let lock;
  const created = [];
  try {
    if (apply) {
      lock = fs.openSync(path.join(root, '.instance.lock'), 'wx', 0o600);
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'migration' }));
      for (const file of files) {
        // Recheck after acquiring the target lock; the source must remain stopped.
        if (hash(fs.readFileSync(file.from)) !== file.sha256) throw new Error('Source changed: ' + file.rel);
        fs.mkdirSync(path.dirname(file.to), { recursive: true });
        const fd = fs.openSync(file.to, 'wx', 0o600);
        created.push(file.to);
        try { fs.writeFileSync(fd, file.data); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        if (hash(fs.readFileSync(file.to)) !== file.sha256) throw new Error('Copy verification failed: ' + file.rel);
      }
    }
    console.log(JSON.stringify({ system: manifest.id, applied: apply,
      files: files.map(({ rel, sha256 }) => ({ file: rel, sha256 })) }, null, 2));
    if (!apply) console.log('Dry run only. No files written. Stop source and target before --apply.');
  } catch (error) {
    // Roll back only files created by this invocation, never pre-existing files.
    for (const file of created) fs.unlinkSync(file);
    throw error;
  } finally {
    if (lock !== undefined) {
      fs.closeSync(lock);
      fs.unlinkSync(path.join(root, '.instance.lock'));
    }
  }
}
try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
