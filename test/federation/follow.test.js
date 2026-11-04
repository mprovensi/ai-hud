const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Peers } = require('../../src/federation/peers');

test('o hub segue o secundário por long-polling quando ele informa a versão, e a cada 10 s quando não', async (t) => {
  const urls = [];
  let reportVersion = true;
  const peer = http.createServer((req, res) => {
    urls.push(req.url.replace(/[?&]t=[^&]*/, ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...(reportVersion ? { version: `v${urls.length}` } : {}), active: [], recent: [], quotas: {}, today: {}, hours: [], days: [] }));
  });
  await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => peer.close(resolve)));
  const peers = new Peers([{ name: 'PC-Desktop', url: `http://127.0.0.1:${peer.address().port}`, token: 'x' }]);
  const p = peers.list[0];
  const scheduled = [];
  peers.schedule = (fn, ms) => scheduled.push(ms); // a próxima volta não roda sozinha no teste
  let updates = 0;

  await peers.follow(p, () => { updates++; });
  assert.equal(urls[0], '/api/snapshot', 'primeira consulta: ainda não sabe a versão');
  assert.equal(p.version, 'v1');
  await peers.follow(p, () => { updates++; });
  assert.equal(urls[1], '/api/snapshot?desde=v1&espera=25');
  assert.equal(updates, 2, 'cada snapshot recebido avisa o coletor');
  assert.deepEqual(scheduled, [0, 0], 'com versão, a próxima consulta sai na hora (quem espera é o secundário)');

  reportVersion = false; // secundário com versão antiga do HUD
  await peers.follow(p, () => {});
  assert.equal(p.version, null);
  await peers.follow(p, () => {});
  assert.equal(urls[3], '/api/snapshot');
  assert.deepEqual(scheduled.slice(2), [10e3, 10e3]);
});
