'use strict';

// 端到端测试：在临时目录启动一个真实的服务器，用 fetch 逐项验证。
// 同一套测试同时用于两个实现：npm test（Node 版）、npm run test:python（Python 版）。
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

const IMPL = process.env.FILESHARE_IMPL || 'node';
const PYTHON = process.env.PYTHON || 'python3';
function startServer(dir, env) {
  return startServerImpl(IMPL, dir, env);
}

function startServerImpl(impl, dir, env) {
  const [cmd, args, extra] = impl === 'python'
    ? [PYTHON, ['-m', 'remote_fileshare', dir], { PYTHONPATH: path.join(__dirname, '..', 'src'), PYTHONUNBUFFERED: '1' }]
    : [process.execPath, [path.join(__dirname, '..', 'remote-fileshare.js'), dir], {}];
  const child = spawn(cmd, args, { env: { ...process.env, ...extra, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', d => { out += d; if (out.includes('已启动')) resolve(); });
    child.on('exit', code => reject(new Error('server exited ' + code)));
  });
  return { child, ready };
}

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
  const started = startServer(root, { PASS, PORT: String(port), HOST: '127.0.0.1' });
  server = started.child;
  await started.ready;
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
  const made = await req('/?mkdir=dir', { method: 'POST' });
  assert.equal(made.status, 201, await made.text());
  const res = await req('/dir');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/dir/');
  await req('/' + encodeURIComponent('<img src=x onerror=alert(1)>.txt'), { method: 'PUT', body: 'x' });
  const html = await (await req('/')).text();
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.txt'));
});

test('TRUST_PROXY：按 X-Forwarded-For 区分客户端限流', async () => {
  const port = await freePort();
  const { child: proxied, ready } = startServer(root, { PASS, PORT: String(port), HOST: '127.0.0.1', TRUST_PROXY: '1' });
  try {
    await ready;
    const url = `http://127.0.0.1:${port}/`;
    const bad = 'Basic ' + Buffer.from('admin:wrong').toString('base64');
    for (let i = 0; i < 10; i++) await fetch(url, { headers: { authorization: bad, 'x-forwarded-for': '203.0.113.9' } });
    assert.equal((await fetch(url, { headers: { authorization: auth, 'x-forwarded-for': '203.0.113.9' } })).status, 429);
    assert.equal((await fetch(url, { headers: { authorization: auth, 'x-forwarded-for': '198.51.100.7' } })).status, 200);
  } finally {
    proxied.kill();
  }
});

test('keep-alive：被拒绝的上传不会把请求体残留到下一个请求', async () => {
  const sock = net.connect(Number(new URL(base).port), '127.0.0.1');
  await new Promise(resolve => sock.once('connect', resolve));
  let buf = '';
  sock.on('data', d => { buf += d; });
  const until = async pred => { for (let i = 0; i < 100 && !pred(); i++) await new Promise(r => setTimeout(r, 20)); };
  const host = new URL(base).host;
  sock.write(`PUT /ka.txt HTTP/1.1\r\nHost: ${host}\r\nAuthorization: ${auth}\r\nContent-Length: 1\r\n\r\na`);
  await until(() => / 201 /.test(buf));
  assert.match(buf, /^HTTP\/1\.1 201 /);
  buf = '';
  sock.write(`PUT /ka2.txt HTTP/1.1\r\nHost: ${host}\r\nAuthorization: ${auth}\r\nOrigin: https://evil.example\r\nContent-Length: 1\r\n\r\nx`);
  await until(() => / 403 /.test(buf));
  assert.match(buf, /^HTTP\/1\.1 403 /);
  // 服务器要么关闭连接，要么正确处理下一个请求，绝不能把残留的 "x" 当成下一个请求的开头。
  buf = '';
  if (!sock.destroyed && sock.writable) {
    sock.write(`GET /ka.txt HTTP/1.1\r\nHost: ${host}\r\nAuthorization: ${auth}\r\n\r\n`);
    await until(() => buf.length > 0 || sock.destroyed);
    if (buf) assert.match(buf, /^HTTP\/1\.1 200 /);
  }
  sock.destroy();
  await req('/ka.txt', { method: 'DELETE' });
});

test('两个实现生成的目录页面完全一致', async t => {
  const dir = path.join(tmp, 'parity');
  fs.mkdirSync(path.join(dir, 'dir10'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dir2'));
  fs.writeFileSync(path.join(dir, 'b.txt'), '');
  fs.writeFileSync(path.join(dir, 'A.md'), 'x'.repeat(2304)); // 2.25 KB：四舍五入的边界
  fs.writeFileSync(path.join(dir, '中文 & <名字>.png'), 'x'.repeat(1500000));
  fs.writeFileSync(path.join(dir, "it's.bin"), 'x'.repeat(10 * 1024 * 1024 - 1));
  const pages = {};
  for (const impl of ['node', 'python']) {
    const port = await freePort();
    const { child, ready } = startServerImpl(impl, dir, { PASS, PORT: String(port), HOST: '127.0.0.1' });
    try {
      await ready;
      const get = p => fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: auth } }).then(r => r.text());
      pages[impl] = [await get('/'), await get('/dir10/')];
    } catch (err) {
      if (impl === 'python') return t.skip('没有可用的 python3：' + err.message);
      throw err;
    } finally {
      child.kill();
    }
  }
  assert.equal(pages.python[0], pages.node[0]);
  assert.equal(pages.python[1], pages.node[1]);
});

test('版本号一致', () => {
  const pkg = require('../package.json');
  const init = fs.readFileSync(path.join(__dirname, '..', 'src', 'remote_fileshare', '__init__.py'), 'utf8');
  assert.equal(/__version__ = "([^"]+)"/.exec(init)[1], pkg.version);
  const js = fs.readFileSync(path.join(__dirname, '..', 'remote-fileshare.js'), 'utf8');
  assert.equal(/const VERSION = '([^']+)'/.exec(js)[1], pkg.version);
});

test('ui.py 与 Node 版界面同步', () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'sync-ui.js'), '--check']);
});

// 放在最后：会把 127.0.0.1 锁定，之后对主服务器的请求都会返回 429。
test('连续登录失败后锁定', async () => {
  const bad = 'Basic ' + Buffer.from('admin:wrong').toString('base64');
  for (let i = 0; i < 10; i++) await fetch(base + '/', { headers: { authorization: bad } });
  assert.equal((await req('/')).status, 429);
});
