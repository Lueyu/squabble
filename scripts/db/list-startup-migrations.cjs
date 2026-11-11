const fs = require('node:fs');
const path = require('node:path');

// Keep CI's upgrade replay tied to the application's explicit startup registry.
const provider = fs.readFileSync(path.resolve(__dirname, '../../server/common/platform/database.provider.ts'), 'utf8');
const migrations = [...provider.matchAll(/'(\d\d_[^']+\.sql)'/gu)].map(match => match[1]);
if (!migrations.length) throw new Error('Startup migration registry could not be read.');
for (const migration of migrations) {
  if (!fs.existsSync(path.join(__dirname, migration))) throw new Error(`Missing startup migration: ${migration}`);
  process.stdout.write(migration + '\n');
}
