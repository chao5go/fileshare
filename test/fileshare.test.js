'use strict';

// 端到端测试：在临时目录启动一个真实的服务器，用 fetch 逐项验证。运行：npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const PASS = 'test-password-123';
let server, base, root, tmp;
const auth = 'Basic ' + Buffer.from('admin:' + PASS).toString('base64');
const req = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts, headers: { authorization: auth, ...opts.headers } });

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fileshare-test-'));
  root = path.join(tmp, 'share');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(__dirname, '..', 'fileshare.js'), root], {
    env: { ...process.env, PASS, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('已启动')) resolve(); });
    server.on('exit', code => reject(new Error('server exited ' + code)));
  });
});

after(() => {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('未登录返回 401，错误密码返回 401，正确密码返回 200', async () => {
  assert.equal((await fetch(base + '/')).status, 401);
  const bad = 'Basic ' + Buffer.from('admin:nope').toString('base64');
  assert.equal((await fetch(base + '/', { headers: { authorization: bad } })).status, 401);
  const ok = await req('/');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /文件共享/);
});

test('PUT 上传（含中文名和多级目录）后下载内容一致', async () => {
  const body = 'hello 世界 ' + 'x'.repeat(100000);
  const url = '/' + ['资料', 'a b', '测试.txt'].map(encodeURIComponent).join('/');
  assert.equal((await req(url, { method: 'PUT', body })).status, 201);
  const res = await req(url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), body);
  assert.match(res.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''%E6%B5%8B%E8%AF%95\.txt$/);
});

test('Range 请求返回 206 和正确片段', async () => {
  await req('/range.bin', { method: 'PUT', body: '0123456789' });
  const res = await req('/range.bin', { headers: { range: 'bytes=2-5' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await res.text(), '2345');
  const tail = await req('/range.bin', { headers: { range: 'bytes=-3' } });
  assert.equal(await tail.text(), '789');
  assert.equal((await req('/range.bin', { headers: { range: 'bytes=50-' } })).status, 416);
});

test('预览：图片按类型内联返回并带沙箱，HTML 当纯文本', async () => {
  await req('/a.png', { method: 'PUT', body: 'png' });
  await req('/x.html', { method: 'PUT', body: '<script>alert(1)</script>' });
  const img = await req('/a.png?preview');
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('content-disposition'), /^inline/);
  assert.equal(img.headers.get('content-security-policy'), 'sandbox');
  const page = await req('/x.html?preview');
  assert.match(page.headers.get('content-type'), /^text\/plain/);
});

test('?tar 打包能被 tar tzf 解开', async () => {
  const res = await req('/' + encodeURIComponent('资料') + '/?tar');
  assert.equal(res.status, 200);
  const file = path.join(tmp, 'out.tar.gz');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const listing = execFileSync('tar', ['tzf', file], { encoding: 'utf8' });
  assert.match(listing, /资料\/a b\/测试\.txt/);
});

test('路径穿越和符号链接越界被拒绝', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%5csecret.txt']) {
    const res = await req(p);
    assert.ok([403, 404].includes(res.status), p + ' → ' + res.status);
    assert.notEqual(await res.text(), 'outside');
  }
  fs.symlinkSync(tmp, path.join(root, 'escape'));
  assert.equal((await req('/escape/secret.txt')).status, 403);
  assert.equal((await req('/escape/new.txt', { method: 'PUT', body: 'x' })).status, 403);
  assert.equal((await req('/escape/sub/new.txt', { method: 'PUT', body: 'x' })).status, 403);
  assert.equal((await req('/escape/?mkdir=evil', { method: 'POST' })).status, 403);
  assert.equal(fs.existsSync(path.join(tmp, 'sub')), false);
  assert.equal(fs.existsSync(path.join(tmp, 'evil')), false);
  // 删除符号链接只删链接本身
  assert.equal((await req('/escape', { method: 'DELETE' })).status, 204);
  assert.equal(fs.readFileSync(path.join(tmp, 'secret.txt'), 'utf8'), 'outside');
});

test('mkdir / 改名 / 删除 返回正确状态码', async () => {
  assert.equal((await req('/?mkdir=' + encodeURIComponent('新目录/子目录'), { method: 'POST' })).status, 201);
  assert.ok(fs.statSync(path.join(root, '新目录', '子目录')).isDirectory());
  assert.equal((await req('/?mkdir=' + encodeURIComponent('../evil'), { method: 'POST' })).status, 403);

  await req('/r1.txt', { method: 'PUT', body: '1' });
  await req('/r2.txt', { method: 'PUT', body: '2' });
  assert.equal((await req('/r1.txt?rename=r2.txt', { method: 'POST' })).status, 409, '不能覆盖已有文件');
  assert.equal((await req('/r1.txt?rename=' + encodeURIComponent('新目录/r1.txt'), { method: 'POST' })).status, 204);
  assert.equal(fs.readFileSync(path.join(root, '新目录', 'r1.txt'), 'utf8'), '1');
  assert.equal((await req('/' + encodeURIComponent('新目录') + '/?rename=' + encodeURIComponent('新目录/子目录/x'), { method: 'POST' })).status, 400);
  assert.equal((await req('/missing.txt?rename=a', { method: 'POST' })).status, 404);

  assert.equal((await req('/' + encodeURIComponent('新目录') + '/', { method: 'DELETE' })).status, 204);
  assert.equal(fs.existsSync(path.join(root, '新目录')), false);
  assert.equal((await req('/', { method: 'DELETE' })).status, 403);
  assert.equal((await req('/missing.txt', { method: 'DELETE' })).status, 404);
});

test('跨站写请求被拒绝，同源放行', async () => {
  const evil = await req('/?mkdir=csrf', { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(fs.existsSync(path.join(root, 'csrf')), false);
  const same = await req('/?mkdir=same', { method: 'POST', headers: { origin: base } });
  assert.equal(same.status, 201);
});

test('目录不带斜杠时重定向，HTML 转义文件名', async () => {
  await req('/?mkdir=dir', { method: 'POST' });
  const res = await req('/dir');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/dir/');
  await req('/' + encodeURIComponent('<img src=x onerror=alert(1)>.txt'), { method: 'PUT', body: 'x' });
  const html = await (await req('/')).text();
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.txt'));
});

test('连续登录失败后锁定', async () => {
  const bad = 'Basic ' + Buffer.from('admin:wrong').toString('base64');
  for (let i = 0; i < 10; i++) await fetch(base + '/', { headers: { authorization: bad } });
  assert.equal((await req('/')).status, 429);
});
