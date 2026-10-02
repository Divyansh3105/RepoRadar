const assert = require('assert');
const { parseStatus, parseBranches } = require('./scan');

assert.deepStrictEqual(
  parseStatus('## main...origin/main [ahead 2, behind 1]\0 M src/a.js\0?? notes.txt\0'),
  { branch: 'main', changes: 2, untracked: 1, files: ['src/a.js', 'notes.txt'] },
);
assert.deepStrictEqual(parseStatus('## feature/x\0'), { branch: 'feature/x', changes: 0, untracked: 0, files: [] });
assert.deepStrictEqual(parseStatus('## No commits yet on master\0?? a\0'), { branch: 'master', changes: 1, untracked: 1, files: ['a'] });
// a rename is followed by its source path; spaces in names are not quoted under -z
assert.deepStrictEqual(
  parseStatus('## main\0R  renamed\0a\0?? sp ace.txt\0'),
  { branch: 'main', changes: 2, untracked: 1, files: ['renamed', 'sp ace.txt'] },
);

assert.deepStrictEqual(
  parseBranches('main\torigin/main\t[ahead 3, behind 1]\nwip\t\t\nold\torigin/old\t[gone]\nsynced\torigin/synced\t\n'),
  [
    { name: 'main', upstream: 'origin/main', gone: false, ahead: 3 },
    { name: 'wip', upstream: null, gone: false, ahead: 0 },
    { name: 'old', upstream: 'origin/old', gone: true, ahead: 0 },
    { name: 'synced', upstream: 'origin/synced', gone: false, ahead: 0 },
  ],
);

console.log('ok');
