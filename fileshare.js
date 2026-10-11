#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const USERNAME = 'admin';
const DEFAULT_PASSWORD = 'change-me';
const PASSWORD = process.env.PASS || DEFAULT_PASSWORD;
const PORT = 8001;
const ROOT = path.resolve(process.argv[2] || '.');
const ROOT_REAL = fs.realpathSync(ROOT);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function authorized(req) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(value.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const colon = decoded.indexOf(':');
  if (colon < 0 || decoded.slice(0, colon) !== USERNAME) return false;
  return crypto.timingSafeEqual(sha256(decoded.slice(colon + 1)), sha256(PASSWORD));
}

function fail(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(message + '\n');
}

function decodePath(rawPathname) {
  let decoded;
  try { decoded = decodeURIComponent(rawPathname); } catch { throw Object.assign(new Error('路径编码无效'), { status: 400 }); }
  if (decoded.includes('\0')) throw Object.assign(new Error('路径包含非法字符'), { status: 400 });
  decoded = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(path.join(ROOT, decoded));
  const relative = path.relative(ROOT, target);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw Object.assign(new Error('禁止访问共享目录之外的路径'), { status: 403 });
  }
  return target;
}

function assertRealInside(target) {
  const real = fs.realpathSync(target);
  const relative = path.relative(ROOT_REAL, real);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw Object.assign(new Error('符号链接指向共享目录之外'), { status: 403 });
  }
  return real;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function urlPath(target) {
  const rel = path.relative(ROOT, target);
  if (!rel) return '/';
  return '/' + rel.split(path.sep).map(encodeURIComponent).join('/');
}

function disposition(filename) {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function sizeText(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
}

function icon(kind) {
  return kind === 'dir'
    ? '<svg class="typeIcon folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5a2 2 0 0 1 2-2h5l2 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
    : '<svg class="typeIcon file" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l4 4v14.4H6z"/><path d="M14 2.8v4h4"/></svg>';
}

async function renderDirectory(req, res, target) {
  const dirents = await fs.promises.readdir(target, { withFileTypes: true });
  const entries = await Promise.all(dirents.map(async d => {
    const full = path.join(target, d.name);
    const stat = await fs.promises.stat(full).catch(() => null);
    return stat && { name: d.name, full, dir: d.isDirectory(), stat };
  }));
  entries.sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));

  const rel = path.relative(ROOT, target);
  const crumbs = ['<a href="/">共享空间</a>'];
  if (rel) {
    let current = ROOT;
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part);
      crumbs.push(`<span>/</span><a href="${urlPath(current)}/">${esc(part)}</a>`);
    }
  }
  const rows = entries.map(e => {
    const href = urlPath(e.full) + (e.dir ? '/' : '');
    const dl = e.dir ? href + '?tar' : href;
    const label = e.dir ? '文件夹' : '文件';
    return `<div class="row" data-name="${esc(e.name.toLocaleLowerCase())}" draggable="true" data-download="${esc(dl)}" data-filename="${esc(e.dir ? e.name + '.tar.gz' : e.name)}">
      <div class="name">${icon(e.dir ? 'dir' : 'file')}<a href="${href}" ${e.dir ? '' : 'download'}>${esc(e.name)}</a>${e.dir ? `<a class="pack" href="${href}?tar">打包</a>` : ''}</div>
      <div class="size">${e.dir ? '—' : esc(sizeText(e.stat.size))}</div>
      <div class="time">${esc(e.stat.mtime.toLocaleString('zh-CN', { hour12: false }))}</div>
      <div class="actions"><button data-action="copy" data-path="${esc(e.full)}">复制路径</button><button data-action="rename" data-url="${esc(href)}" data-name="${esc(e.name)}">改名</button><button class="danger" data-action="delete" data-url="${esc(href)}" data-name="${esc(e.name)}">删除</button></div>
    </div>`;
  }).join('');
  const safeBase = JSON.stringify(urlPath(target) + (target === ROOT ? '' : '/')).replace(/</g, '\\u003c');
  const logo = '<svg viewBox="0 0 44 44" aria-hidden="true"><rect width="44" height="44" rx="12" fill="#4f46e5"/><path d="M15 18l7-7 7 7M22 12v20M29 26l-7 7-7-7" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const favicon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 44 44'%3E%3Crect width='44' height='44' rx='12' fill='%234f46e5'/%3E%3Cpath d='M15 18l7-7 7 7M22 12v20M29 26l-7 7-7-7' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="icon" href="${favicon}"><title>${esc(rel || '共享空间')} · 文件共享</title><style>
:root{--bg:#f5f6fb;--card:#fff;--text:#181a27;--muted:#70748a;--line:#e5e7f0;--hover:#f0f1ff;--primary:#4f46e5;--primary2:#3730a3;--danger:#d83b2d;--shadow:0 15px 45px rgba(42,45,80,.08)}
@media(prefers-color-scheme:dark){:root{--bg:#11131b;--card:#1a1d29;--text:#f0f1f8;--muted:#9297ad;--line:#303444;--hover:#24283a;--primary:#8b83ff;--primary2:#b0abff;--danger:#ff695c;--shadow:0 18px 50px rgba(0,0,0,.25)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}a{color:var(--primary);text-decoration:none}button,input{font:inherit}.wrap{width:min(1100px,calc(100% - 32px));margin:0 auto;padding:38px 0 70px}.brand{display:flex;align-items:center;gap:13px;margin-bottom:30px}.brand svg{width:42px;height:42px}.brand h1{font-size:22px;margin:0;letter-spacing:-.02em}.brand p{margin:1px 0 0;color:var(--muted);font-size:13px}.toolbar{display:flex;gap:10px;align-items:center;margin:18px 0}.filter{min-width:160px;flex:1;border:1px solid var(--line);color:var(--text);background:var(--card);border-radius:11px;padding:10px 13px;outline:none}.filter:focus{border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 16%,transparent)}.btn{border:0;background:var(--primary);color:white;border-radius:10px;padding:10px 14px;cursor:pointer;font-weight:650}.btn.secondary{background:var(--card);color:var(--primary);border:1px solid var(--line)}.crumbs{font:13px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);display:flex;gap:8px;flex-wrap:wrap}.card{background:var(--card);border:1px solid var(--line);border-radius:17px;box-shadow:var(--shadow);overflow:hidden}.row{display:grid;grid-template-columns:minmax(220px,1fr) 100px 185px 205px;align-items:center;min-height:58px;padding:0 18px;border-bottom:1px solid var(--line);transition:background .15s}.row:last-child{border-bottom:0}.row:hover{background:var(--hover)}.head{min-height:43px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}.name{min-width:0;display:flex;align-items:center;gap:10px}.name>a:first-of-type{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-weight:600}.typeIcon{width:21px;height:21px;flex:none;fill:none;stroke:var(--muted);stroke-width:1.7}.typeIcon.folder{fill:color-mix(in srgb,var(--primary) 17%,transparent);stroke:var(--primary)}.size,.time,.crumbs{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.size,.time{font-size:12px;color:var(--muted)}.pack{font-size:11px;padding:2px 6px;border:1px solid var(--line);border-radius:5px}.actions{display:flex;justify-content:flex-end;opacity:.12;transition:opacity .15s}.row:hover .actions{opacity:1}.actions button{border:0;background:transparent;color:var(--primary);cursor:pointer;padding:7px}.actions .danger:hover{color:var(--danger)}.empty{text-align:center;padding:70px 20px;color:var(--muted)}.empty strong{display:block;color:var(--text);font-size:18px;margin-bottom:5px}.drop{position:fixed;z-index:20;inset:14px;display:none;place-items:center;border:3px dashed var(--primary);border-radius:24px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(5px);font-size:24px;font-weight:750;color:var(--primary);pointer-events:none}.drop.show{display:grid}.progressTop{position:fixed;z-index:30;left:0;top:0;height:3px;background:var(--danger);width:0;transition:width .15s}.status{min-height:24px;color:var(--muted);font-size:13px}.status.error{color:var(--danger)}#picker,#folderPicker{display:none}
@media(max-width:600px){.wrap{width:min(100% - 20px,1100px);padding-top:20px}.toolbar{flex-wrap:wrap}.filter{flex-basis:100%}.row{grid-template-columns:minmax(105px,1fr) 55px 150px;padding:0 8px}.time{display:none}.head{grid-template-columns:minmax(105px,1fr) 55px 150px}.actions{opacity:.75}.actions button{padding:6px 4px;font-size:12px}.brand{margin-bottom:20px}.pack{display:none}}
@media(hover:none){.actions{opacity:1}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body><div class="progressTop" id="progressTop"></div><div class="drop" id="drop">松开即可上传到这里</div><main class="wrap"><header class="brand">${logo}<div><h1>文件共享</h1><p>轻巧、安全，随取随放</p></div></header><nav class="crumbs">${crumbs.join('')}</nav><div class="toolbar"><input id="filter" class="filter" type="search" placeholder="筛选当前目录…" autocomplete="off"><button class="btn" id="upload">上传文件</button><button class="btn secondary" id="uploadFolder">上传文件夹</button><button class="btn secondary" id="mkdir">新建目录</button><input id="picker" type="file" multiple><input id="folderPicker" type="file" webkitdirectory multiple></div><div class="status" id="status"></div><section class="card"><div class="row head"><div>名称</div><div>大小</div><div class="time">修改时间</div><div></div></div><div id="list">${rows || '<div class="empty"><strong>这里还是空的</strong>上传文件，或新建一个目录开始整理。</div>'}</div></section></main><script>
const BASE=${safeBase}, list=document.querySelector('#list'), statusEl=document.querySelector('#status'), bar=document.querySelector('#progressTop');
const pathURL=p=>BASE+p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
document.querySelector('#filter').addEventListener('input',e=>{const q=e.target.value.trim().toLocaleLowerCase();document.querySelectorAll('#list .row').forEach(r=>r.hidden=!r.dataset.name.includes(q))});
document.querySelector('#upload').onclick=()=>document.querySelector('#picker').click();document.querySelector('#uploadFolder').onclick=()=>document.querySelector('#folderPicker').click();
document.querySelector('#picker').onchange=e=>uploadFiles([...e.target.files]);document.querySelector('#folderPicker').onchange=e=>uploadFiles([...e.target.files]);
function setStatus(text,error=false){statusEl.textContent=text;statusEl.classList.toggle('error',error)}
async function uploadFiles(files){if(!files.length)return;for(let i=0;i<files.length;i++){const f=files[i],rel=f.webkitRelativePath||f._relativePath||f.name;await new Promise((ok,bad)=>{const x=new XMLHttpRequest();x.open('PUT',pathURL(rel));x.upload.onprogress=e=>{const pct=e.lengthComputable?Math.round(e.loaded/e.total*100):0;setStatus('上传第 '+(i+1)+' / 共 '+files.length+' 个 · '+pct+'% · '+rel);bar.style.width=((i+(e.lengthComputable?e.loaded/e.total:0))/files.length*100)+'%'};x.onload=()=>x.status>=200&&x.status<300?ok():bad(new Error(x.responseText||('HTTP '+x.status)));x.onerror=()=>bad(new Error('网络错误'));x.send(f)}).catch(e=>{setStatus(e.message,true);throw e})}setStatus('上传完成，正在刷新…');bar.style.width='100%';setTimeout(()=>location.reload(),300)}
document.querySelector('#mkdir').onclick=async()=>{const name=prompt('新目录名称（可包含相对路径）');if(!name)return;const r=await fetch(BASE+'?mkdir='+encodeURIComponent(name),{method:'POST'});if(r.ok)location.reload();else setStatus(await r.text(),true)};
async function copyText(text){if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text)}else{const t=document.createElement('textarea');t.value=text;t.style.cssText='position:fixed;left:-9999px;top:0';document.body.appendChild(t);t.focus();t.select();const ok=document.execCommand('copy');t.remove();if(!ok)throw new Error('浏览器未允许复制')}}
list.addEventListener('click',async e=>{const b=e.target.closest('button[data-action]');if(!b)return;if(b.dataset.action==='copy'){try{await copyText(b.dataset.path);setStatus('已复制：'+b.dataset.path)}catch(err){setStatus('复制失败：'+err.message,true)}return}if(b.dataset.action==='rename'){const name=prompt('新名称或相对路径（相对于当前目录）',b.dataset.name);if(!name||name===b.dataset.name)return;const r=await fetch(b.dataset.url+'?rename='+encodeURIComponent(name),{method:'POST'});if(r.ok)location.reload();else setStatus(await r.text(),true)}else{if(!confirm('确定递归删除“'+b.dataset.name+'”？此操作不可撤销。'))return;const r=await fetch(b.dataset.url,{method:'DELETE'});if(r.ok)location.reload();else setStatus(await r.text(),true)}});
let dragDepth=0,draggingOut=false;const drop=document.querySelector('#drop');
document.addEventListener('dragstart',e=>{const row=e.target.closest('.row[data-download]');if(!row)return;draggingOut=true;const absolute=new URL(row.dataset.download,location.href).href;e.dataTransfer.setData('DownloadURL','application/octet-stream:'+row.dataset.filename+':'+absolute);e.dataTransfer.effectAllowed='copy'});document.addEventListener('dragend',()=>{draggingOut=false;dragDepth=0;drop.classList.remove('show')});
document.addEventListener('dragenter',e=>{if(draggingOut)return;e.preventDefault();dragDepth++;drop.classList.add('show')});document.addEventListener('dragover',e=>{if(!draggingOut)e.preventDefault()});document.addEventListener('dragleave',()=>{if(draggingOut)return;dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)drop.classList.remove('show')});
document.addEventListener('drop',async e=>{if(draggingOut)return;e.preventDefault();dragDepth=0;drop.classList.remove('show');const items=[...e.dataTransfer.items],files=[];if(items.some(i=>i.webkitGetAsEntry)){for(const item of items){const entry=item.webkitGetAsEntry&&item.webkitGetAsEntry();if(entry)await walkEntry(entry,'',files)}}else files.push(...e.dataTransfer.files);uploadFiles(files).catch(()=>{})});
async function walkEntry(entry,prefix,out){if(entry.isFile){await new Promise(resolve=>entry.file(f=>{f._relativePath=prefix+f.name;out.push(f);resolve()},resolve))}else if(entry.isDirectory){const reader=entry.createReader(),all=[];while(true){const batch=await new Promise(resolve=>reader.readEntries(resolve,()=>resolve([])));if(!batch.length)break;all.push(...batch)}for(const child of all)await walkEntry(child,prefix+entry.name+'/',out)}}
</script></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(html);
}

function streamFile(req, res, target, stat) {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': disposition(path.basename(target)), 'X-Content-Type-Options': 'nosniff' });
  const stream = fs.createReadStream(target);
  stream.on('error', err => { if (!res.headersSent) fail(res, 500, err.message); else res.destroy(err); });
  stream.pipe(res);
}

function streamTar(req, res, target) {
  const base = path.basename(target) || 'fileshare';
  res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': disposition(base + '.tar.gz'), 'X-Content-Type-Options': 'nosniff' });
  const parent = target === ROOT ? ROOT : path.dirname(target);
  const item = target === ROOT ? '.' : path.basename(target);
  const tar = spawn('tar', ['-czf', '-', '-C', parent, '--', item], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  tar.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 4096) stderr = stderr.slice(-4096); });
  tar.on('error', err => res.destroy(err));
  tar.on('close', code => { if (code !== 0) res.destroy(new Error(stderr || `tar 退出码 ${code}`)); });
  res.on('close', () => { if (!res.writableEnded && !tar.killed) tar.kill(); });
  tar.stdout.pipe(res);
}

async function handle(req, res) {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="File Share", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('需要登录\n');
  }
  const qmark = req.url.indexOf('?');
  const rawPathname = qmark < 0 ? req.url : req.url.slice(0, qmark);
  const query = new URLSearchParams(qmark < 0 ? '' : req.url.slice(qmark + 1));
  let target;
  try { target = decodePath(rawPathname); } catch (err) { return fail(res, err.status || 400, err.message); }

  try {
    if (req.method === 'PUT') {
      if (target === ROOT) return fail(res, 400, '不能将文件上传为共享根目录');
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      assertRealInside(path.dirname(target));
      const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(8).toString('hex')}.upload`);
      const out = fs.createWriteStream(tmp, { flags: 'wx' });
      let settled = false;
      const cleanup = () => fs.promises.rm(tmp, { force: true }).catch(() => {});
      req.pipe(out);
      req.on('aborted', () => { out.destroy(); cleanup(); });
      out.on('error', err => { if (!settled) { settled = true; cleanup(); fail(res, 500, err.message); } });
      out.on('finish', async () => { if (settled) return; settled = true; try { await fs.promises.rename(tmp, target); res.writeHead(201); res.end(); } catch (err) { await cleanup(); fail(res, 500, err.message); } });
      return;
    }

    if (req.method === 'POST' && query.has('mkdir')) {
      const name = query.get('mkdir');
      if (!name) return fail(res, 400, '目录名不能为空');
      const dest = decodePath(urlPath(target) + '/' + name.split('/').map(encodeURIComponent).join('/'));
      await fs.promises.mkdir(dest, { recursive: true });
      assertRealInside(dest);
      res.writeHead(201); return res.end();
    }

    if (req.method === 'POST' && query.has('rename')) {
      if (target === ROOT) return fail(res, 403, '不能改名共享根目录');
      assertRealInside(target);
      const name = query.get('rename');
      if (!name) return fail(res, 400, '新名称不能为空');
      const parentUrl = urlPath(path.dirname(target));
      const dest = decodePath(parentUrl + '/' + name.split('/').map(encodeURIComponent).join('/'));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      assertRealInside(path.dirname(dest));
      await fs.promises.rename(target, dest);
      res.writeHead(204); return res.end();
    }

    if (req.method === 'DELETE') {
      if (target === ROOT) return fail(res, 403, '不能删除共享根目录');
      assertRealInside(target);
      await fs.promises.rm(target, { recursive: true, force: false });
      res.writeHead(204); return res.end();
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '不支持此方法');
    const real = assertRealInside(target);
    const stat = await fs.promises.stat(real);
    if (query.has('tar')) {
      if (!stat.isDirectory()) return fail(res, 400, '只能打包文件夹');
      return streamTar(req, res, real);
    }
    if (stat.isDirectory()) return renderDirectory(req, res, real);
    if (!stat.isFile()) return fail(res, 403, '不支持此文件类型');
    return streamFile(req, res, real, stat);
  } catch (err) {
    const status = err.status || (err.code === 'ENOENT' ? 404 : err.code === 'EEXIST' ? 409 : err.code === 'EACCES' ? 403 : 500);
    return fail(res, status, status === 500 ? '服务器错误：' + err.message : err.message);
  }
}

const server = http.createServer((req, res) => { handle(req, res).catch(err => { if (!res.headersSent) fail(res, 500, '服务器错误：' + err.message); else res.destroy(err); }); });
server.listen(PORT, '0.0.0.0', () => {
  console.log(`文件共享服务器已启动：http://0.0.0.0:${PORT}`);
  console.log(`共享目录：${ROOT}`);
  console.log(`用户名：${USERNAME}`);
  console.log(`密码来源：${process.env.PASS ? '环境变量 PASS' : '文件内默认常量'}`);
});
