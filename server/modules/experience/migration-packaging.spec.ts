import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,existsSync } from 'node:fs';
test('Docker runtime contains every migration required by application startup',()=>{
  const docker=readFileSync('Dockerfile','utf8'),provider=readFileSync('server/common/platform/database.provider.ts','utf8');
  const migrations=[...provider.matchAll(/'(\d\d_[^']+\.sql)'/gu)].map(m=>m[1]);
  const copiesDirectory=/^COPY\s+scripts\/db\/?\s+\.\/scripts\/db\/?\s*$/mu.test(docker);
  for(const file of migrations){
    assert.ok(existsSync('scripts/db/'+file),`Startup migration exists: ${file}`);
    assert.ok(copiesDirectory||docker.includes(`COPY scripts/db/${file} ./scripts/db/${file}`),`Docker runtime must contain ${file}`);
  }
});
