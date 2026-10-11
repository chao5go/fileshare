#!/usr/bin/env node
'use strict';

// fileshare — 零依赖的单文件网页文件共享服务器。
// 用法：node fileshare.js [共享目录]    详见 README.md

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VERSION = '1.0.0';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`fileshare ${VERSION}

用法：node fileshare.js [共享目录]

环境变量：
  PORT      监听端口（默认 8001）
  HOST      监听地址（默认 0.0.0.0）
  FS_USER   登录用户名（默认 admin）
  PASS      登录密码（不设置则首次运行随机生成，并保存到密码文件）
  PASS_FILE 密码文件路径（默认 ~/.config/fileshare/password）
  TRUST_PROXY=1  放在本机反向代理（Caddy/Nginx）后面时设置，从 X-Forwarded-For 读取真实客户端 IP`);
  process.exit(0);
}
if (process.argv.includes('-v') || process.argv.includes('--version')) { console.log(VERSION); process.exit(0); }

const USERNAME = process.env.FS_USER || 'admin';
const PORT = Number(process.env.PORT) || 8001;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PASS_FILE = process.env.PASS_FILE || path.join(os.homedir(), '.config', 'fileshare', 'password');
const ROOT = fs.realpathSync(path.resolve(process.argv.slice(2).find(a => !a.startsWith('-')) || '.'));

let passwordGenerated = false;
function loadPassword() {
  if (process.env.PASS) return process.env.PASS;
  try {
    const saved = fs.readFileSync(PASS_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const generated = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(path.dirname(PASS_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(PASS_FILE, generated + '\n', { mode: 0o600 });
  passwordGenerated = true;
  return generated;
}
const PASSWORD = loadPassword();
const PASSWORD_HASH = sha256(PASSWORD);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

// 登录失败限流：同一 IP 在 WINDOW 内失败 MAX_FAILS 次后锁定 WINDOW。
const MAX_FAILS = 10, WINDOW = 10 * 60 * 1000;
const failures = new Map();
function locked(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > WINDOW) { failures.delete(ip); return false; }
  return f.count >= MAX_FAILS;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > WINDOW) failures.set(ip, { count: 1, since: Date.now() });
  else f.count++;
  if (failures.size > 10000) for (const [k, v] of failures) if (Date.now() - v.since > WINDOW) failures.delete(k);
}

function authorized(req) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(value.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  const userOk = crypto.timingSafeEqual(sha256(decoded.slice(0, colon)), sha256(USERNAME));
  const passOk = crypto.timingSafeEqual(sha256(decoded.slice(colon + 1)), PASSWORD_HASH);
  return userOk && passOk;
}

// 浏览器会自动带上缓存的 Basic Auth 凭据，所以跨站页面发来的写操作必须拒绝（CSRF）。
// curl 等非浏览器客户端不带 Origin 头，不受影响。
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return req.headers['sec-fetch-site'] !== 'cross-site';
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function fail(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(message + '\n');
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function outside(base, target) {
  const relative = path.relative(base, target);
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}

function decodePath(rawPathname) {
  let decoded;
  try { decoded = decodeURIComponent(rawPathname); } catch { throw httpError(400, '路径编码无效'); }
  if (decoded.includes('\0')) throw httpError(400, '路径包含非法字符');
  decoded = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  // path.relative 先归一化两边，共享根是 / 时也不会出现 // 前缀的比较错误。
  const target = path.resolve(path.join(ROOT, decoded));
  if (outside(ROOT, target)) throw httpError(403, '禁止访问共享目录之外的路径');
  return target;
}

function assertRealInside(target) {
  const real = fs.realpathSync(target);
  if (outside(ROOT, real)) throw httpError(403, '符号链接指向共享目录之外');
  return real;
}

// 用于即将创建的路径：沿父目录向上找到第一个已存在的目录，校验它没有经符号链接跳出共享根。
function assertCreatableInside(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  assertRealInside(current);
}

function childPath(dir, name) {
  return decodePath(urlPath(dir) + '/' + name.split('/').map(encodeURIComponent).join('/'));
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function urlPath(target) {
  const rel = path.relative(ROOT, target);
  if (!rel) return '/';
  return '/' + rel.split(path.sep).map(encodeURIComponent).join('/');
}

function disposition(type, filename) {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function sizeText(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
}

// 预览时使用的类型。HTML/SVG 一律当纯文本或放进 CSP 沙箱，避免上传的页面在本站执行脚本。
const TEXT = 'text/plain; charset=utf-8';
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf',
};
for (const ext of 'txt md markdown log csv tsv json jsonl yaml yml toml ini conf env xml html htm css js mjs cjs ts tsx jsx py rb go rs java kt c h cc cpp hpp cs php sh bash zsh sql diff patch'.split(' ')) MIME[ext] = TEXT;
function previewType(name) {
  return MIME[path.extname(name).slice(1).toLowerCase()];
}

const DL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"/></svg>';

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
    return stat && { name: d.name, full, dir: stat.isDirectory(), stat };
  }));
  const visible = entries.filter(e => e && !/^\..+\.[0-9a-f]{16}\.upload$/.test(e.name));
  visible.sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));

  const rel = path.relative(ROOT, target);
  const crumbs = ['<a href="/">共享空间</a>'];
  if (rel) {
    let current = ROOT;
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part);
      crumbs.push(`<span>/</span><a href="${urlPath(current)}/">${esc(part)}</a>`);
    }
  }
  const rows = visible.map(e => {
    const href = urlPath(e.full) + (e.dir ? '/' : '');
    const dl = e.dir ? href + '?tar' : href;
    const preview = !e.dir && previewType(e.name) ? `<a class="act" href="${href}?preview" target="_blank" rel="noopener">预览</a>` : '';
    return `<div class="row" data-name="${esc(e.name.toLocaleLowerCase())}" draggable="true" data-download="${esc(dl)}" data-filename="${esc(e.dir ? e.name + '.tar.gz' : e.name)}">
      <div class="name">${icon(e.dir ? 'dir' : 'file')}<a href="${href}" ${e.dir ? 'title="打开文件夹"' : 'download title="点击下载"'}>${esc(e.name)}</a></div>
      <div class="size">${e.dir ? '—' : esc(sizeText(e.stat.size))}</div>
      <div class="time">${esc(e.stat.mtime.toLocaleString('zh-CN', { hour12: false }))}</div>
      <div class="actions"><a class="dl" href="${esc(dl)}" ${e.dir ? '' : 'download'} data-name="${esc(e.name)}" data-tar="${e.dir ? 1 : ''}">${DL_ICON}${e.dir ? '打包下载' : '下载'}</a>${preview.replace('class="act"', 'class="act sub"')}<button class="sub" data-action="copy" data-path="${esc(e.full)}">复制路径</button><button class="sub" data-action="rename" data-url="${esc(href)}" data-name="${esc(e.name)}">改名</button><button class="sub danger" data-action="delete" data-url="${esc(href)}" data-name="${esc(e.name)}">删除</button></div>
    </div>`;
  }).join('');
  const json = v => JSON.stringify(v).replace(/</g, '\\u003c');
  const safeBase = json(urlPath(target) + (target === ROOT ? '' : '/'));
  const logo = '<svg viewBox="0 0 44 44" aria-hidden="true"><rect width="44" height="44" rx="12" fill="#4f46e5"/><path d="M15 18l7-7 7 7M22 12v20M29 26l-7 7-7-7" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const favicon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 44 44'%3E%3Crect width='44' height='44' rx='12' fill='%234f46e5'/%3E%3Cpath d='M15 18l7-7 7 7M22 12v20M29 26l-7 7-7-7' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="icon" href="${favicon}"><title>${esc(rel || '共享空间')} · 文件共享</title><style>
:root{--bg:#f5f6fb;--card:#fff;--text:#181a27;--muted:#70748a;--line:#e5e7f0;--hover:#f0f1ff;--primary:#4f46e5;--primary2:#3730a3;--danger:#d83b2d;--shadow:0 15px 45px rgba(42,45,80,.08)}
@media(prefers-color-scheme:dark){:root{--bg:#11131b;--card:#1a1d29;--text:#f0f1f8;--muted:#9297ad;--line:#303444;--hover:#24283a;--primary:#8b83ff;--primary2:#b0abff;--danger:#ff695c;--shadow:0 18px 50px rgba(0,0,0,.25)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}a{color:var(--primary);text-decoration:none}button,input{font:inherit}.wrap{width:min(1100px,calc(100% - 32px));margin:0 auto;padding:38px 0 70px}.brand{display:flex;align-items:center;gap:13px;margin-bottom:30px}.brand svg{width:42px;height:42px}.brand h1{font-size:22px;margin:0;letter-spacing:-.02em}.brand p{margin:1px 0 0;color:var(--muted);font-size:13px}.toolbar{display:flex;gap:10px;align-items:center;margin:18px 0}.filter{min-width:160px;flex:1;border:1px solid var(--line);color:var(--text);background:var(--card);border-radius:11px;padding:10px 13px;outline:none}.filter:focus{border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 16%,transparent)}.btn{border:0;background:var(--primary);color:white;border-radius:10px;padding:10px 14px;cursor:pointer;font-weight:650;white-space:nowrap}.btn.secondary{background:var(--card);color:var(--primary);border:1px solid var(--line)}.btn:disabled{opacity:.5;cursor:default}.crumbs{font:13px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);display:flex;gap:8px;flex-wrap:wrap;align-items:center}.crumbs .copyDir{margin-left:auto;border:0;background:transparent;color:var(--primary);cursor:pointer;font:12px system-ui,sans-serif;padding:2px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:17px;box-shadow:var(--shadow);overflow:hidden}.row{display:grid;grid-template-columns:minmax(200px,1fr) 90px 170px 330px;align-items:center;min-height:58px;padding:0 18px;border-bottom:1px solid var(--line);transition:background .15s}.row:last-child{border-bottom:0}.row:hover{background:var(--hover)}.head{min-height:43px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}.name{min-width:0;display:flex;align-items:center;gap:10px}.name>a:first-of-type{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-weight:600}.typeIcon{width:21px;height:21px;flex:none;fill:none;stroke:var(--muted);stroke-width:1.7}.typeIcon.folder{fill:color-mix(in srgb,var(--primary) 17%,transparent);stroke:var(--primary)}.size,.time,.crumbs{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.size,.time{font-size:12px;color:var(--muted)}.actions{display:flex;justify-content:flex-start;align-items:center;gap:2px}.actions .sub{opacity:.3;transition:opacity .15s}.row:hover .actions .sub,.row:focus-within .actions .sub{opacity:1}.dl{display:inline-flex;align-items:center;gap:5px;margin-right:6px;padding:6px 12px;border-radius:9px;background:color-mix(in srgb,var(--primary) 13%,transparent);color:var(--primary);font-size:13px;font-weight:650;white-space:nowrap;transition:background .15s,color .15s}.dl:hover,.dl:focus-visible{background:var(--primary);color:#fff}.dl svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.status.ok{color:var(--primary)}.actions button,.actions .act{border:0;background:transparent;color:var(--primary);cursor:pointer;padding:7px;font-size:14px}.actions .danger:hover{color:var(--danger)}.empty{text-align:center;padding:70px 20px;color:var(--muted)}.empty strong{display:block;color:var(--text);font-size:18px;margin-bottom:5px}.drop{position:fixed;z-index:20;inset:14px;display:none;place-items:center;border:3px dashed var(--primary);border-radius:24px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(5px);font-size:24px;font-weight:750;color:var(--primary);pointer-events:none}.drop.show{display:grid}.progressTop{position:fixed;z-index:30;left:0;top:0;height:3px;background:var(--danger);width:0;transition:width .15s}.status{min-height:24px;color:var(--muted);font-size:13px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.status.error{color:var(--danger)}#picker,#folderPicker{display:none}
@media(max-width:600px){.wrap{width:min(100% - 20px,1100px);padding-top:20px}.toolbar{flex-wrap:wrap}.filter{flex-basis:100%}.row{grid-template-columns:minmax(80px,1fr) 52px 172px;padding:0 8px}.time{display:none}.head{grid-template-columns:minmax(80px,1fr) 52px 172px}.actions .sub{opacity:.8}.actions [data-action=copy]{display:none}.actions button,.actions .act{padding:6px 4px;font-size:12px}.dl{padding:5px 9px;font-size:12px;margin-right:2px}.brand{margin-bottom:20px}}
@media(hover:none){.actions .sub{opacity:1}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body><div class="progressTop" id="progressTop"></div><div class="drop" id="drop">松开即可上传到这里</div><main class="wrap"><header class="brand">${logo}<div><h1>文件共享</h1><p>轻巧、安全，随取随放 · 复制路径即可发给 AI agent</p></div></header><nav class="crumbs">${crumbs.join('')}<button class="copyDir" id="copyDir" title="复制当前目录在服务器上的绝对路径">复制当前目录路径</button></nav><div class="toolbar"><input id="filter" class="filter" type="search" placeholder="筛选当前目录…" autocomplete="off"><button class="btn" id="upload">上传文件</button><button class="btn secondary" id="uploadFolder">上传文件夹</button><button class="btn secondary" id="mkdir">新建目录</button><input id="picker" type="file" multiple><input id="folderPicker" type="file" webkitdirectory multiple></div><div class="status" id="status">点文件名或「下载」按钮即可下载到本地；文件夹用「打包下载」得到 .tar.gz。把文件拖到页面上即可上传。</div><section class="card"><div class="row head"><div>名称</div><div>大小</div><div class="time">修改时间</div><div></div></div><div id="list">${rows || '<div class="empty"><strong>这里还是空的</strong>上传文件、把文件拖到页面上，或新建一个目录开始整理。</div>'}</div></section></main><script>
const BASE=${safeBase}, DIR=${json(target)}, list=document.querySelector('#list'), statusEl=document.querySelector('#status'), bar=document.querySelector('#progressTop');
const pathURL=p=>BASE+p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const human=b=>{const u=['B','KB','MB','GB','TB'];let i=0;while(b>=1024&&i<u.length-1){b/=1024;i++}return b.toFixed(i&&b<10?1:0)+' '+u[i]};
const clock=s=>!isFinite(s)?'--':s>=3600?Math.floor(s/3600)+'时'+Math.floor(s%3600/60)+'分':s>=60?Math.floor(s/60)+'分'+Math.round(s%60)+'秒':Math.round(s)+'秒';
let uploading=false;window.addEventListener('beforeunload',e=>{if(uploading){e.preventDefault();e.returnValue=''}});
document.querySelector('#filter').addEventListener('input',e=>{const q=e.target.value.trim().toLocaleLowerCase();document.querySelectorAll('#list .row').forEach(r=>r.hidden=!r.dataset.name.includes(q))});
document.querySelector('#upload').onclick=()=>document.querySelector('#picker').click();document.querySelector('#uploadFolder').onclick=()=>document.querySelector('#folderPicker').click();
document.querySelector('#picker').onchange=e=>uploadFiles([...e.target.files]).catch(()=>{});document.querySelector('#folderPicker').onchange=e=>uploadFiles([...e.target.files]).catch(()=>{});
function setStatus(text,error=false,ok=false){statusEl.textContent=text;statusEl.classList.toggle('error',error);statusEl.classList.toggle('ok',ok)}
document.addEventListener('click',e=>{const a=e.target.closest('a[download],a.dl');if(!a)return;const name=a.dataset.name||a.textContent.trim();setStatus(a.dataset.tar?'正在打包「'+name+'」，开始下载 '+name+'.tar.gz…（文件夹大时要等几秒才开始，请留意浏览器的下载栏）':'已开始下载「'+name+'」，请留意浏览器的下载栏',false,true)});
async function uploadFiles(files){if(!files.length||uploading)return;uploading=true;document.querySelectorAll('.toolbar .btn').forEach(b=>b.disabled=true);const total=files.reduce((s,f)=>s+f.size,0),start=Date.now();let done=0;try{for(let i=0;i<files.length;i++){const f=files[i],rel=f.webkitRelativePath||f._relativePath||f.name;await new Promise((ok,bad)=>{const x=new XMLHttpRequest();x.open('PUT',pathURL(rel));x.upload.onprogress=e=>{const loaded=done+(e.lengthComputable?e.loaded:0),secs=(Date.now()-start)/1000,speed=loaded/Math.max(secs,.001);const pct=total?Math.round(loaded/total*100):100;setStatus('上传第 '+(i+1)+' / 共 '+files.length+' 个 · '+pct+'% · '+human(loaded)+' / '+human(total)+' · '+human(speed)+'/s · 剩余 '+clock((total-loaded)/speed)+' · '+rel);bar.style.width=pct+'%'};x.onload=()=>x.status>=200&&x.status<300?ok():bad(new Error('上传失败：'+rel+' · '+(x.responseText.trim()||('HTTP '+x.status))));x.onerror=()=>bad(new Error('网络错误，上传中断：'+rel));x.send(f)});done+=f.size}setStatus('上传完成（'+files.length+' 个，'+human(total)+'），正在刷新…');bar.style.width='100%';uploading=false;setTimeout(()=>location.reload(),300)}catch(e){setStatus(e.message,true);bar.style.width='0';throw e}finally{uploading=false;document.querySelectorAll('.toolbar .btn').forEach(b=>b.disabled=false)}}
document.querySelector('#mkdir').onclick=async()=>{const name=prompt('新目录名称（可包含相对路径）');if(!name)return;const r=await fetch(BASE+'?mkdir='+encodeURIComponent(name),{method:'POST'});if(r.ok)location.reload();else setStatus(await r.text(),true)};
async function copyText(text){if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text)}else{const t=document.createElement('textarea');t.value=text;t.style.cssText='position:fixed;left:-9999px;top:0';document.body.appendChild(t);t.focus();t.select();const ok=document.execCommand('copy');t.remove();if(!ok)throw new Error('浏览器未允许复制')}}
async function copyPath(p){try{await copyText(p);setStatus('已复制：'+p)}catch(err){setStatus('复制失败：'+err.message,true)}}
document.querySelector('#copyDir').onclick=()=>copyPath(DIR);
list.addEventListener('click',async e=>{const b=e.target.closest('button[data-action]');if(!b)return;if(b.dataset.action==='copy')return copyPath(b.dataset.path);if(b.dataset.action==='rename'){const name=prompt('新名称或相对路径（相对于当前目录）',b.dataset.name);if(!name||name===b.dataset.name)return;const r=await fetch(b.dataset.url+'?rename='+encodeURIComponent(name),{method:'POST'});if(r.ok)location.reload();else setStatus(await r.text(),true)}else{if(!confirm('确定删除“'+b.dataset.name+'”？文件夹会连同内容一起删除，此操作不可撤销。'))return;const r=await fetch(b.dataset.url,{method:'DELETE'});if(r.ok)location.reload();else setStatus(await r.text(),true)}});
let dragDepth=0,draggingOut=false;const drop=document.querySelector('#drop');
document.addEventListener('dragstart',e=>{const row=e.target.closest&&e.target.closest('.row[data-download]');if(!row)return;draggingOut=true;const absolute=new URL(row.dataset.download,location.href).href;e.dataTransfer.setData('DownloadURL','application/octet-stream:'+row.dataset.filename+':'+absolute);e.dataTransfer.effectAllowed='copy'});document.addEventListener('dragend',()=>{draggingOut=false;dragDepth=0;drop.classList.remove('show')});
const hasFiles=e=>[...(e.dataTransfer?.types||[])].includes('Files');
document.addEventListener('dragenter',e=>{if(draggingOut||!hasFiles(e))return;e.preventDefault();dragDepth++;drop.classList.add('show')});document.addEventListener('dragover',e=>{if(!draggingOut&&hasFiles(e))e.preventDefault()});document.addEventListener('dragleave',e=>{if(draggingOut||!hasFiles(e))return;dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)drop.classList.remove('show')});
document.addEventListener('drop',async e=>{if(draggingOut||!hasFiles(e))return;e.preventDefault();dragDepth=0;drop.classList.remove('show');const items=[...e.dataTransfer.items],files=[];if(items.some(i=>i.webkitGetAsEntry)){const entries=items.map(i=>i.webkitGetAsEntry&&i.webkitGetAsEntry()).filter(Boolean);for(const entry of entries)await walkEntry(entry,'',files)}else files.push(...e.dataTransfer.files);uploadFiles(files).catch(()=>{})});
async function walkEntry(entry,prefix,out){if(entry.isFile){await new Promise(resolve=>entry.file(f=>{f._relativePath=prefix+f.name;out.push(f);resolve()},resolve))}else if(entry.isDirectory){const reader=entry.createReader(),all=[];while(true){const batch=await new Promise(resolve=>reader.readEntries(resolve,()=>resolve([])));if(!batch.length)break;all.push(...batch)}for(const child of all)await walkEntry(child,prefix+entry.name+'/',out)}}
</script></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  res.end(html);
}

// 解析单段 Range 请求（断点续传、视频拖动进度条）。返回 null 表示整个文件，false 表示范围无效。
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start > end || start >= size) return false;
  return { start, end };
}

function streamFile(req, res, target, stat, preview) {
  const name = path.basename(target);
  const type = preview ? previewType(name) || 'application/octet-stream' : 'application/octet-stream';
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': type,
    'Content-Disposition': disposition(preview ? 'inline' : 'attachment', name),
    'Accept-Ranges': 'bytes',
    'Last-Modified': stat.mtime.toUTCString(),
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
  };
  // 预览的内容在沙箱里打开，即使是 SVG 或带脚本的文件也拿不到本站权限（PDF 阅读器在沙箱里打不开，单独放行）。
  if (preview && type !== 'application/pdf') headers['Content-Security-Policy'] = 'sandbox';
  const ifRange = req.headers['if-range'];
  let range = parseRange(req.headers.range, stat.size);
  if (range && ifRange && ifRange !== etag && ifRange !== headers['Last-Modified']) range = null;
  if (range === false) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers['Content-Length'] = range.end - range.start + 1;
    res.writeHead(206, headers);
  } else {
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
  }
  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  const stream = fs.createReadStream(target, range || {});
  stream.on('error', err => res.destroy(err));
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function streamTar(req, res, target) {
  const base = target === ROOT ? (path.basename(ROOT) || 'fileshare') : path.basename(target);
  res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': disposition('attachment', base + '.tar.gz'), 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  const parent = target === ROOT ? ROOT : path.dirname(target);
  const item = target === ROOT ? '.' : path.basename(target);
  const tar = spawn('tar', ['-czf', '-', '--exclude=.*.upload', '-C', parent, '--', item], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  tar.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 4096) stderr = stderr.slice(-4096); });
  tar.on('error', err => res.destroy(err));
  // tar 退出码 1 表示打包过程中有文件发生变化，归档仍然可用。
  tar.on('close', code => { if (code > 1) res.destroy(new Error(stderr || `tar 退出码 ${code}`)); });
  res.on('close', () => { if (tar.exitCode === null) tar.kill(); });
  tar.stdout.pipe(res);
}

function receiveUpload(req, res, target) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(8).toString('hex')}.upload`);
  const out = fs.createWriteStream(tmp, { flags: 'wx' });
  let settled = false;
  const cleanup = () => fs.promises.rm(tmp, { force: true }).catch(() => {});
  const abort = () => { if (settled) return; settled = true; out.destroy(); cleanup(); };
  req.on('aborted', abort);
  req.on('error', abort);
  out.on('error', err => { if (settled) return; settled = true; cleanup(); fail(res, 500, '写入失败：' + err.message); });
  out.on('finish', async () => {
    if (settled) return;
    settled = true;
    try {
      const existing = await fs.promises.stat(target).catch(() => null);
      if (existing && existing.isDirectory()) { await cleanup(); return fail(res, 409, '同名文件夹已存在'); }
      await fs.promises.rename(tmp, target);
      log(req, `上传 ${path.relative(ROOT, target)} (${sizeText(out.bytesWritten)})`);
      res.writeHead(201); res.end();
    } catch (err) { await cleanup(); fail(res, 500, err.message); }
  });
  req.pipe(out);
}

// 反向代理后面所有请求都来自本机，必须取代理追加的 X-Forwarded-For 最后一项，否则登录限流会把所有人一起锁住。
// 只信任来自本机的代理，防止外部直接伪造这个头。
function clientIp(req) {
  const remote = req.socket.remoteAddress || '-';
  if (TRUST_PROXY && /^(127\.|::1$|::ffff:127\.)/.test(remote)) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean).pop();
    if (forwarded) return forwarded;
  }
  return remote;
}

function log(req, message) {
  console.log(`${new Date().toISOString()} ${clientIp(req)} ${message}`);
}

async function handle(req, res) {
  const ip = clientIp(req);
  if (locked(ip)) return fail(res, 429, '登录失败次数过多，请稍后再试');
  if (!authorized(req)) {
    if (req.headers.authorization) { recordFailure(ip); log(req, '登录失败'); }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="File Share", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('需要登录\n');
  }
  failures.delete(ip);

  const qmark = req.url.indexOf('?');
  const rawPathname = qmark < 0 ? req.url : req.url.slice(0, qmark);
  const query = new URLSearchParams(qmark < 0 ? '' : req.url.slice(qmark + 1));
  const reading = req.method === 'GET' || req.method === 'HEAD';
  if (!reading && !sameOrigin(req)) return fail(res, 403, '拒绝跨站请求');
  let target;
  try { target = decodePath(rawPathname); } catch (err) { return fail(res, err.status || 400, err.message); }

  try {
    if (req.method === 'PUT') {
      if (target === ROOT || rawPathname.endsWith('/')) return fail(res, 400, '上传需要指定文件名');
      assertCreatableInside(path.dirname(target));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      assertRealInside(path.dirname(target));
      return receiveUpload(req, res, target);
    }

    if (req.method === 'POST' && query.has('mkdir')) {
      const name = query.get('mkdir');
      if (!name) return fail(res, 400, '目录名不能为空');
      assertRealInside(target);
      const dest = childPath(target, name);
      assertCreatableInside(dest);
      await fs.promises.mkdir(dest, { recursive: true });
      assertRealInside(dest);
      log(req, `新建目录 ${path.relative(ROOT, dest)}`);
      res.writeHead(201); return res.end();
    }

    if (req.method === 'POST' && query.has('rename')) {
      if (target === ROOT) return fail(res, 403, '不能改名共享根目录');
      const name = query.get('rename');
      if (!name) return fail(res, 400, '新名称不能为空');
      await fs.promises.lstat(target);
      assertRealInside(path.dirname(target));
      const dest = childPath(path.dirname(target), name);
      if (dest === ROOT) return fail(res, 400, '新名称无效');
      if (dest === target) { res.writeHead(204); return res.end(); }
      if (dest.startsWith(target + path.sep)) return fail(res, 400, '不能把文件夹移动到它自己里面');
      if (await fs.promises.lstat(dest).catch(() => null)) return fail(res, 409, '目标已存在：' + name);
      assertCreatableInside(path.dirname(dest));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      assertRealInside(path.dirname(dest));
      await fs.promises.rename(target, dest);
      log(req, `改名 ${path.relative(ROOT, target)} → ${path.relative(ROOT, dest)}`);
      res.writeHead(204); return res.end();
    }

    if (req.method === 'DELETE') {
      if (target === ROOT) return fail(res, 403, '不能删除共享根目录');
      // 删除的是链接本身而不是它指向的内容，只需保证所在目录在共享根内。
      await fs.promises.lstat(target);
      assertRealInside(path.dirname(target));
      await fs.promises.rm(target, { recursive: true, force: false });
      log(req, `删除 ${path.relative(ROOT, target)}`);
      res.writeHead(204); return res.end();
    }

    if (!reading) return fail(res, 405, '不支持此方法');
    const real = assertRealInside(target);
    const stat = await fs.promises.stat(real);
    if (query.has('tar')) {
      if (!stat.isDirectory()) return fail(res, 400, '只能打包文件夹');
      return streamTar(req, res, real);
    }
    if (stat.isDirectory()) {
      if (!rawPathname.endsWith('/')) { res.writeHead(301, { Location: rawPathname + '/' + (qmark < 0 ? '' : req.url.slice(qmark)) }); return res.end(); }
      return renderDirectory(req, res, real);
    }
    if (!stat.isFile()) return fail(res, 403, '不支持此文件类型');
    return streamFile(req, res, real, stat, query.has('preview'));
  } catch (err) {
    const status = err.status || ({ ENOENT: 404, ENOTDIR: 404, EEXIST: 409, ENOTEMPTY: 409, EACCES: 403, EPERM: 403, EXDEV: 400, ENOSPC: 507 })[err.code] || 500;
    return fail(res, status, status === 500 ? '服务器错误：' + err.message : err.message);
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => { if (!res.headersSent) fail(res, 500, '服务器错误：' + err.message); else res.destroy(err); });
});
// 境外服务器上传大文件可能要几十分钟，关闭 Node 默认的 5 分钟请求超时。
server.requestTimeout = 0;
server.headersTimeout = 60 * 1000;
server.listen(PORT, HOST, () => {
  console.log(`fileshare ${VERSION} 已启动：http://${HOST}:${PORT}`);
  console.log(`共享目录：${ROOT}`);
  console.log(`用户名：${USERNAME}`);
  if (process.env.PASS) console.log('密码：来自环境变量 PASS');
  else if (passwordGenerated) console.log(`密码：${PASSWORD}（已随机生成并保存到 ${PASS_FILE}）`);
  else console.log(`密码：保存在 ${PASS_FILE}`);
  if (ROOT === path.parse(ROOT).root) console.warn('警告：共享根目录是整个文件系统，任何登录的人都能读写所有文件。');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
