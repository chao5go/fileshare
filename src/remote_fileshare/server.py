"""remote-fileshare 的 Python 实现，只用标准库。

与 Node 版 remote-fileshare.js 功能、接口和网页完全一致（同一套测试）。网页界面来自 ui.py，
由 scripts/sync-ui.js 从 Node 版生成。用法：uvx remote-fileshare [共享目录]
"""

import base64
import errno
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import signal
import socket
import stat as statmod
import subprocess
import sys
import tarfile
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import __version__, ui

HELP = """remote-fileshare {version} — 远程文件共享

用法：remote-fileshare [共享目录] [--https]

  --https   自动获取外网 IP，并通过 Caddy 自动申请、续期证书，提供 https://外网IP:端口
            需要已安装 Caddy 2.10+，并放行 80 端口（申请证书用）和监听端口

环境变量：
  PORT      监听端口（默认 8001；--https 时为 HTTPS 端口）
  HOST      监听地址（默认 0.0.0.0）
  FS_USER   登录用户名（默认 admin）
  PASS      登录密码（不设置则首次运行随机生成，并保存到密码文件）
  PASS_FILE 密码文件路径（默认 ~/.config/remote-fileshare/password）
  TRUST_PROXY=1  放在本机反向代理（Caddy/Nginx）后面时设置，从 X-Forwarded-For 读取真实客户端 IP
  PUBLIC_HOST    外网地址（IP 或域名），不设置则自动获取外网 IP
  CADDY          Caddy 可执行文件路径（默认在 PATH 里找 caddy）"""

UPLOAD_TMP = re.compile(r"^\..+\.[0-9a-f]{16}\.upload$")
CHUNK = 256 * 1024


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


ERRNO_STATUS = {
    errno.ENOENT: 404, errno.ENOTDIR: 404, errno.EEXIST: 409, errno.ENOTEMPTY: 409,
    errno.EACCES: 403, errno.EPERM: 403, errno.EXDEV: 400, errno.ENOSPC: 507,
}


def sha256(value):
    return hashlib.sha256(value.encode("utf-8", "surrogatepass")).digest()


class Config:
    def __init__(self):
        args = [a for a in sys.argv[1:] if not a.startswith("-")]
        self.https = "--https" in sys.argv
        self.user = os.environ.get("FS_USER", "").strip() or "admin"
        try:
            self.port = int(os.environ.get("PORT") or 8001) or 8001
        except ValueError:
            self.port = 8001
        # --https 时本程序只监听本机随机端口，由 Caddy 对外提供 HTTPS 并转发过来。
        self.host = "127.0.0.1" if self.https else os.environ.get("HOST") or "0.0.0.0"
        self.trust_proxy = self.https or os.environ.get("TRUST_PROXY") == "1"
        self.config_dir = os.path.join(os.path.expanduser("~"), ".config", "remote-fileshare")
        self.pass_file = os.environ.get("PASS_FILE") or os.path.join(self.config_dir, "password")
        root = os.path.abspath(args[0] if args else ".")
        if not os.path.isdir(root):
            sys.exit(f"共享目录不存在：{root}")
        self.root = os.path.realpath(root)
        self.password_generated = False
        self.password = self.load_password()
        self.password_hash = sha256(self.password)

    def load_password(self):
        if os.environ.get("PASS", "").strip():
            return os.environ["PASS"].strip()
        try:
            with open(self.pass_file, encoding="utf-8") as f:
                saved = f.read().strip()
            if saved:
                return saved
        except FileNotFoundError:
            pass
        generated = secrets.token_urlsafe(18)
        os.makedirs(os.path.dirname(self.pass_file), mode=0o700, exist_ok=True)
        fd = os.open(self.pass_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(generated + "\n")
        self.password_generated = True
        return generated


# 登录失败限流：同一 IP 在 WINDOW 内失败 MAX_FAILS 次后锁定 WINDOW。
MAX_FAILS, WINDOW = 10, 10 * 60
failures = {}
failures_lock = threading.Lock()


def locked(ip):
    with failures_lock:
        f = failures.get(ip)
        if not f:
            return False
        if time.time() - f["since"] > WINDOW:
            del failures[ip]
            return False
        return f["count"] >= MAX_FAILS


def record_failure(ip):
    with failures_lock:
        now = time.time()
        f = failures.get(ip)
        if not f or now - f["since"] > WINDOW:
            failures[ip] = {"count": 1, "since": now}
        else:
            f["count"] += 1
        if len(failures) > 10000:
            for k in [k for k, v in failures.items() if now - v["since"] > WINDOW]:
                del failures[k]


def clear_failures(ip):
    with failures_lock:
        failures.pop(ip, None)


def esc(value):
    return "".join({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}.get(c, c) for c in str(value))


def js_json(value):
    return json.dumps(value, ensure_ascii=False).replace("<", "\\u003c")


def encode_component(value):
    """与 JavaScript 的 encodeURIComponent 相同。"""
    return urllib.parse.quote(value, safe="!~*'()")


def disposition(kind, filename):
    encoded = urllib.parse.quote(filename, safe="")
    fallback = re.sub(r'["\\]', "_", re.sub(r"[^\x20-\x7E]", "_", filename)) or "download"
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"


def size_text(size):
    if size < 1024:
        return f"{size} B"
    units = ["KB", "MB", "GB", "TB"]
    n, i = size / 1024, 0
    while n >= 1024 and i < len(units) - 1:
        n /= 1024
        i += 1
    # 与 JavaScript 的 toFixed 一致：对浮点数的精确值四舍五入（半数进位）。
    return f"{Decimal(n).quantize(Decimal('0.1') if n < 10 else Decimal('1'), rounding=ROUND_HALF_UP)} {units[i]}"


def time_text(mtime):
    t = time.localtime(mtime)
    return f"{t.tm_year}/{t.tm_mon}/{t.tm_mday} {t.tm_hour:02d}:{t.tm_min:02d}:{t.tm_sec:02d}"


# 预览时使用的类型。HTML/SVG 一律当纯文本或放进 CSP 沙箱，避免上传的页面在本站执行脚本。
TEXT = "text/plain; charset=utf-8"
MIME = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif", "bmp": "image/bmp", "ico": "image/x-icon", "svg": "image/svg+xml",
    "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime", "mp3": "audio/mpeg", "m4a": "audio/mp4", "wav": "audio/wav", "ogg": "audio/ogg", "flac": "audio/flac",
    "pdf": "application/pdf",
}
for _ext in "txt md markdown log csv tsv json jsonl yaml yml toml ini conf env xml html htm css js mjs cjs ts tsx jsx py rb go rs java kt c h cc cpp hpp cs php sh bash zsh sql diff patch".split():
    MIME[_ext] = TEXT


def preview_type(name):
    return MIME.get(os.path.splitext(name)[1][1:].lower())


# 文件夹内排序：数字按数值比较，其余不区分大小写、按码位比较。与 Node 版的 compareNames 规则相同。
def natural_key(name):
    return [(0, int(part), "") if DIGITS.fullmatch(part) else (1, 0, part.lower()) for part in DIGITS.split(name) if part]


DIGITS = re.compile(r"([0-9]+)")


def parse_range(header, size):
    """解析单段 Range 请求。返回 None 表示整个文件，False 表示范围无效。"""
    if not header:
        return None
    m = re.match(r"^bytes=(\d*)-(\d*)$", header.strip())
    if not m or (not m.group(1) and not m.group(2)):
        return None
    if not m.group(1):
        start, end = max(0, size - int(m.group(2))), size - 1
    else:
        start = int(m.group(1))
        end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
    if start > end or start >= size:
        return False
    return start, end


class TarWriter:
    """把 tarfile 的输出直接写到响应里，流式打包不落盘。"""

    def __init__(self, wfile):
        self.wfile = wfile

    def write(self, data):
        self.wfile.write(data)
        return len(data)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "remote-fileshare/" + __version__
    # 两次收到数据之间最多等待的秒数，用来回收空闲连接；不限制整个上传的总时长。
    timeout = 300

    @property
    def cfg(self):
        return self.server.cfg

    def log_message(self, format, *args):
        pass

    def log(self, message):
        stamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        print(f"{stamp} {self.client_ip()} {message}", flush=True)

    # 反向代理后面所有请求都来自本机，必须取代理追加的 X-Forwarded-For 最后一项，否则登录限流会把所有人一起锁住。
    # 只信任来自本机的代理，防止外部直接伪造这个头。
    def client_ip(self):
        remote = self.client_address[0] if self.client_address else "-"
        if self.cfg.trust_proxy and re.match(r"^(127\.|::1$|::ffff:127\.)", remote):
            forwarded = [v.strip() for v in (self.headers.get("X-Forwarded-For") or "").split(",") if v.strip()]
            if forwarded:
                return forwarded[-1]
        return remote

    # ---- 响应工具 ----
    def send(self, status, headers=None, body=b""):
        self.send_response(status)
        headers = dict(headers or {})
        headers.setdefault("Content-Length", str(len(body)))
        for k, v in headers.items():
            self.send_header(k, v)
        if self.body_pending():
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def fail(self, status, message):
        self.send(status, {"Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff"}, (message + "\n").encode("utf-8"))

    def body_pending(self):
        if getattr(self, "_body_read", False):
            return False
        return bool(self.headers.get("Content-Length", "0") not in ("", "0") or self.headers.get("Transfer-Encoding"))

    # ---- 路径 ----
    def outside(self, base, target):
        rel = os.path.relpath(target, base)
        return rel == ".." or rel.startswith(".." + os.sep) or os.path.isabs(rel)

    def decode_path(self, raw):
        try:
            decoded = urllib.parse.unquote_to_bytes(raw.encode("latin-1")).decode("utf-8")
        except (UnicodeError, ValueError):
            raise HttpError(400, "路径编码无效")
        if "\0" in decoded:
            raise HttpError(400, "路径包含非法字符")
        decoded = decoded.replace("\\", "/").lstrip("/")
        # relpath 先归一化两边，共享根是 / 时也不会出现 // 前缀的比较错误。
        target = os.path.normpath(os.path.join(self.cfg.root, decoded))
        if self.outside(self.cfg.root, target):
            raise HttpError(403, "禁止访问共享目录之外的路径")
        return target

    def assert_real_inside(self, target):
        real = os.path.realpath(target)
        os.stat(real)
        if self.outside(self.cfg.root, real):
            raise HttpError(403, "符号链接指向共享目录之外")
        return real

    # 用于即将创建的路径：沿父目录向上找到第一个已存在的目录，校验它没有经符号链接跳出共享根。
    def assert_creatable_inside(self, target):
        current = target
        while not os.path.exists(current):
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
        self.assert_real_inside(current)

    def url_path(self, target):
        rel = os.path.relpath(target, self.cfg.root)
        if rel == ".":
            return "/"
        return "/" + "/".join(encode_component(p) for p in rel.split(os.sep))

    def child_path(self, directory, name):
        return self.decode_path(self.url_path(directory) + "/" + "/".join(encode_component(p) for p in name.split("/")))

    def rel(self, target):
        rel = os.path.relpath(target, self.cfg.root)
        return "" if rel == "." else rel

    # ---- 认证与跨站防护 ----
    def authorized(self):
        value = self.headers.get("Authorization") or ""
        if not value.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(value[6:]).decode("utf-8", "replace")
        except (ValueError, TypeError):
            return False
        if ":" not in decoded:
            return False
        # 去掉首尾空白：复制粘贴密码时常带上多余的空格或换行。
        user, password = (part.strip() for part in decoded.split(":", 1))
        user_ok = hmac.compare_digest(sha256(user), sha256(self.cfg.user))
        pass_ok = hmac.compare_digest(sha256(password), self.cfg.password_hash)
        return user_ok and pass_ok

    # 浏览器会自动带上缓存的 Basic Auth 凭据，所以跨站页面发来的写操作必须拒绝（CSRF）。
    # curl 等非浏览器客户端不带 Origin 头，不受影响。
    def same_origin(self):
        origin = self.headers.get("Origin")
        if origin is None:
            return self.headers.get("Sec-Fetch-Site") != "cross-site"
        try:
            parsed = urllib.parse.urlsplit(origin)
        except ValueError:
            return False
        return bool(parsed.scheme) and parsed.netloc.lower() == (self.headers.get("Host") or "").lower()

    # ---- 请求入口 ----
    def do_GET(self):
        self.handle_request()

    do_HEAD = do_PUT = do_POST = do_DELETE = do_PATCH = do_OPTIONS = do_GET

    def handle_request(self):
        # 同一个 Handler 会处理一条 keep-alive 连接上的所有请求，状态必须按请求重置。
        self._body_read = False
        try:
            self.route()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as err:  # noqa: BLE001 与 Node 版一致：任何意外错误都返回 500
            try:
                self.fail(500, "服务器错误：" + str(err))
            except OSError:
                self.close_connection = True

    def route(self):
        ip = self.client_ip()
        if locked(ip):
            return self.fail(429, "登录失败次数过多，请稍后再试")
        if not self.authorized():
            if self.headers.get("Authorization"):
                record_failure(ip)
                self.log("登录失败")
            return self.send(401, {"WWW-Authenticate": 'Basic realm="File Share", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8"}, "需要登录\n".encode("utf-8"))
        clear_failures(ip)

        raw_path, _, raw_query = self.path.partition("?")
        query = urllib.parse.parse_qs(raw_query.encode("latin-1").decode("utf-8", "replace"), keep_blank_values=True)
        reading = self.command in ("GET", "HEAD")
        if not reading and not self.same_origin():
            return self.fail(403, "拒绝跨站请求")
        try:
            target = self.decode_path(raw_path)
        except HttpError as err:
            return self.fail(err.status, str(err))

        try:
            self.dispatch(target, raw_path, raw_query, query, reading)
        except HttpError as err:
            self.fail(err.status, str(err))
        except OSError as err:
            status = ERRNO_STATUS.get(err.errno, 500)
            self.fail(status, "服务器错误：" + str(err) if status == 500 else str(err))

    def dispatch(self, target, raw_path, raw_query, query, reading):
        root = self.cfg.root
        if self.command == "PUT":
            if target == root or raw_path.endswith("/"):
                return self.fail(400, "上传需要指定文件名")
            self.assert_creatable_inside(os.path.dirname(target))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            self.assert_real_inside(os.path.dirname(target))
            return self.receive_upload(target)

        if self.command == "POST" and "mkdir" in query:
            name = query["mkdir"][0]
            if not name:
                return self.fail(400, "目录名不能为空")
            self.assert_real_inside(target)
            dest = self.child_path(target, name)
            self.assert_creatable_inside(dest)
            os.makedirs(dest, exist_ok=True)
            self.assert_real_inside(dest)
            self.log(f"新建目录 {self.rel(dest)}")
            return self.send(201)

        if self.command == "POST" and "rename" in query:
            if target == root:
                return self.fail(403, "不能改名共享根目录")
            name = query["rename"][0]
            if not name:
                return self.fail(400, "新名称不能为空")
            os.lstat(target)
            self.assert_real_inside(os.path.dirname(target))
            dest = self.child_path(os.path.dirname(target), name)
            if dest == root:
                return self.fail(400, "新名称无效")
            if dest == target:
                return self.send(204)
            if dest.startswith(target + os.sep):
                return self.fail(400, "不能把文件夹移动到它自己里面")
            if os.path.lexists(dest):
                return self.fail(409, "目标已存在：" + name)
            self.assert_creatable_inside(os.path.dirname(dest))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            self.assert_real_inside(os.path.dirname(dest))
            os.rename(target, dest)
            self.log(f"改名 {self.rel(target)} → {self.rel(dest)}")
            return self.send(204)

        if self.command == "DELETE":
            if target == root:
                return self.fail(403, "不能删除共享根目录")
            # 删除的是链接本身而不是它指向的内容，只需保证所在目录在共享根内。
            st = os.lstat(target)
            self.assert_real_inside(os.path.dirname(target))
            if statmod.S_ISDIR(st.st_mode):
                shutil.rmtree(target)
            else:
                os.unlink(target)
            self.log(f"删除 {self.rel(target)}")
            return self.send(204)

        if not reading:
            return self.fail(405, "不支持此方法")
        real = self.assert_real_inside(target)
        st = os.stat(real)
        if "tar" in query:
            if not statmod.S_ISDIR(st.st_mode):
                return self.fail(400, "只能打包文件夹")
            return self.stream_tar(real)
        if statmod.S_ISDIR(st.st_mode):
            if not raw_path.endswith("/"):
                return self.send(301, {"Location": raw_path + "/" + ("?" + raw_query if "?" in self.path else "")})
            return self.render_directory(real)
        if not statmod.S_ISREG(st.st_mode):
            return self.fail(403, "不支持此文件类型")
        return self.stream_file(real, st, "preview" in query)

    # ---- 目录页面 ----
    def render_directory(self, target):
        entries = []
        with os.scandir(target) as it:
            for d in it:
                full = os.path.join(target, d.name)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                if UPLOAD_TMP.match(d.name):
                    continue
                entries.append((d.name, full, statmod.S_ISDIR(st.st_mode), st))
        entries.sort(key=lambda e: (not e[2], natural_key(e[0]), e[0]))

        rel = self.rel(target)
        crumbs = ['<a href="/">共享空间</a>']
        if rel:
            current = self.cfg.root
            for part in rel.split(os.sep):
                current = os.path.join(current, part)
                crumbs.append(f'<span>/</span><a href="{self.url_path(current)}/">{esc(part)}</a>')

        rows = []
        for name, full, is_dir, st in entries:
            href = self.url_path(full) + ("/" if is_dir else "")
            dl = href + "?tar" if is_dir else href
            link_attr = 'title="打开文件夹"' if is_dir else 'download title="点击下载"'
            preview = f'<a class="act sub" href="{href}?preview" target="_blank" rel="noopener">预览</a>' if not is_dir and preview_type(name) else ""
            rows.append(
                f'<div class="row" data-name="{esc(name.lower())}" draggable="true" data-download="{esc(dl)}" data-filename="{esc(name + ".tar.gz" if is_dir else name)}">\n'
                f'      <div class="name">{ui.ICON_DIR if is_dir else ui.ICON_FILE}<a href="{href}" {link_attr}>{esc(name)}</a></div>\n'
                f'      <div class="size">{"—" if is_dir else esc(size_text(st.st_size))}</div>\n'
                f'      <div class="time">{esc(time_text(st.st_mtime))}</div>\n'
                f'      <div class="actions"><a class="dl" href="{esc(dl)}" {"" if is_dir else "download"} data-name="{esc(name)}" data-tar="{1 if is_dir else ""}">{ui.DL_ICON}{"打包下载" if is_dir else "下载"}</a>{preview}'
                f'<button class="sub" data-action="copy" data-path="{esc(full)}">复制路径</button>'
                f'<button class="sub" data-action="rename" data-url="{esc(href)}" data-name="{esc(name)}">改名</button>'
                f'<button class="sub danger" data-action="delete" data-url="{esc(href)}" data-name="{esc(name)}">删除</button></div>\n'
                f'    </div>'
            )
        base = self.url_path(target) + ("" if target == self.cfg.root else "/")
        html = (
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<meta name="color-scheme" content="light dark"><link rel="icon" href="{ui.FAVICON}"><title>{esc(rel or "共享空间")} · 远程文件共享</title>'
            f"<style>\n{ui.STYLE}\n</style></head><body>{ui.TOP}{''.join(crumbs)}{ui.MIDDLE}{''.join(rows) or ui.EMPTY}{ui.BOTTOM}"
            f"<script>\nconst BASE={js_json(base)}, DIR={js_json(target)};\n{ui.SCRIPT}\n</script></body></html>"
        ).encode("utf-8")
        self.send(200, {
            "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
        }, html)

    # ---- 下载 ----
    def stream_file(self, target, st, preview):
        name = os.path.basename(target)
        ctype = (preview_type(name) or "application/octet-stream") if preview else "application/octet-stream"
        etag = f'"{st.st_size:x}-{st.st_mtime_ns // 1_000_000:x}"'
        last_modified = formatdate(st.st_mtime, usegmt=True)
        headers = {
            "Content-Type": ctype,
            "Content-Disposition": disposition("inline" if preview else "attachment", name),
            "Accept-Ranges": "bytes",
            "Last-Modified": last_modified,
            "ETag": etag,
            "X-Content-Type-Options": "nosniff",
        }
        # 预览的内容在沙箱里打开，即使是 SVG 或带脚本的文件也拿不到本站权限（PDF 阅读器在沙箱里打不开，单独放行）。
        if preview and ctype != "application/pdf":
            headers["Content-Security-Policy"] = "sandbox"
        if_range = self.headers.get("If-Range")
        rng = parse_range(self.headers.get("Range"), st.st_size)
        if rng and if_range and if_range not in (etag, last_modified):
            rng = None
        if rng is False:
            return self.send(416, {"Content-Range": f"bytes */{st.st_size}"})
        if rng:
            start, end = rng
            headers["Content-Range"] = f"bytes {start}-{end}/{st.st_size}"
            status = 206
        else:
            start, end = 0, st.st_size - 1
            status = 200
        length = end - start + 1 if st.st_size else 0
        headers["Content-Length"] = str(length)
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command == "HEAD" or not length:
            return
        with open(target, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(CHUNK, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)
        if remaining:
            self.close_connection = True

    def stream_tar(self, target):
        root = self.cfg.root
        base = (os.path.basename(root) or "remote-fileshare") if target == root else os.path.basename(target)
        self.send_response(200)
        self.send_header("Content-Type", "application/gzip")
        self.send_header("Content-Disposition", disposition("attachment", base + ".tar.gz"))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if self.command == "HEAD":
            return

        def skip_uploads(info):
            return None if UPLOAD_TMP.match(os.path.basename(info.name)) else info

        arcname = "." if target == root else os.path.basename(target)
        # 响应头已经发出，中途出错只能断开连接，让客户端知道归档不完整。
        try:
            with tarfile.open(fileobj=TarWriter(self.wfile), mode="w|gz", format=tarfile.PAX_FORMAT) as tar:
                tar.add(target, arcname=arcname, filter=skip_uploads)
        except Exception as err:  # noqa: BLE001
            print(f"打包 {self.rel(target) or '.'} 失败：{err}", file=sys.stderr, flush=True)
            raise ConnectionResetError from err

    # ---- 上传 ----
    def read_body(self, out):
        """把请求体写入 out，支持 Content-Length 和 chunked。返回写入的字节数，连接中断时返回 None。"""
        self._body_read = True
        written = 0
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            while True:
                line = self.rfile.readline(65537)
                if not line:
                    return None
                size = int(line.split(b";", 1)[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline(65537) not in (b"\r\n", b"\n", b""):
                        pass
                    return written
                remaining = size
                while remaining:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        return None
                    out.write(chunk)
                    written += len(chunk)
                    remaining -= len(chunk)
                self.rfile.readline(65537)
        remaining = int(self.headers.get("Content-Length") or 0)
        while remaining:
            chunk = self.rfile.read(min(CHUNK, remaining))
            if not chunk:
                return None
            out.write(chunk)
            written += len(chunk)
            remaining -= len(chunk)
        return written

    def receive_upload(self, target):
        tmp = os.path.join(os.path.dirname(target), f".{os.path.basename(target)}.{secrets.token_hex(8)}.upload")
        try:
            with open(tmp, "xb") as out:
                try:
                    written = self.read_body(out)
                except (OSError, ValueError):
                    written = None
            if written is None:
                self.close_connection = True
                os.remove(tmp)
                return
            if os.path.isdir(target):
                os.remove(tmp)
                return self.fail(409, "同名文件夹已存在")
            os.replace(tmp, target)
        except OSError as err:
            if os.path.exists(tmp):
                os.remove(tmp)
            return self.fail(500, "写入失败：" + str(err))
        self.log(f"上传 {self.rel(target)} ({size_text(written)})")
        self.send(201)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def local_addresses():
    found = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 80))
            found.append(s.getsockname()[0])
    except OSError:
        pass
    return found


def is_ip(value):
    try:
        socket.inet_pton(socket.AF_INET6 if ":" in value else socket.AF_INET, value)
        return True
    except (OSError, ValueError):
        return False


# 依次询问几个公共服务，拿到本机的外网 IP。PUBLIC_HOST 可以直接指定（IP 或域名）。
IP_SERVICES = ["https://api.ipify.org", "https://ifconfig.me/ip", "https://ipv4.icanhazip.com"]


def public_host():
    if os.environ.get("PUBLIC_HOST"):
        return os.environ["PUBLIC_HOST"]
    for url in IP_SERVICES:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
            with urllib.request.urlopen(req, timeout=4) as r:
                ip = r.read().decode().strip()
            if is_ip(ip):
                return ip
        except Exception:  # noqa: BLE001 换下一个服务
            continue
    return None


def host_port(host, port):
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


# Caddy 配置：对外 HTTPS，误用 http:// 访问时自动跳转；IP 地址使用 Let's Encrypt 的短期 IP 证书（约 6 天，自动续期）。
def caddyfile(host, port, backend):
    ip_cert = "\n\ttls {\n\t\tissuer acme {\n\t\t\tdir https://acme-v02.api.letsencrypt.org/directory\n\t\t\tprofile shortlived\n\t\t}\n\t}" if is_ip(host) else ""
    return (
        "# 由 remote-fileshare --https 自动生成，每次启动都会覆盖。\n"
        "{\n\tadmin off\n"
        f"\tservers :{port} {{\n\t\tlistener_wrappers {{\n\t\t\thttp_redirect\n\t\t\ttls\n\t\t}}\n\t}}\n}}\n\n"
        f"{host_port(host, port)} {{{ip_cert}\n\treverse_proxy 127.0.0.1:{backend}\n}}\n"
    )


def start_https(cfg, backend):
    host = public_host()
    if not host:
        sys.exit("无法自动获取外网 IP，请用环境变量 PUBLIC_HOST 指定外网 IP 或域名。")
    os.makedirs(cfg.config_dir, mode=0o700, exist_ok=True)
    config = os.path.join(cfg.config_dir, "Caddyfile")
    with open(config, "w", encoding="utf-8") as f:
        f.write(caddyfile(host, cfg.port, backend))
    try:
        caddy = subprocess.Popen([os.environ.get("CADDY") or "caddy", "run", "--config", config, "--adapter", "caddyfile"],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except FileNotFoundError:
        print("--https 需要 Caddy 2.10 以上版本，请先安装：https://caddyserver.com/docs/install", file=sys.stderr)
        print("  Debian/Ubuntu：参考上面链接添加官方源后 apt install caddy；macOS：brew install caddy", file=sys.stderr)
        sys.exit(1)

    # Caddy 的日志是 JSON，只挑出证书和错误相关的告诉用户；Caddy 退出则整个程序退出。
    def watch():
        for raw in caddy.stderr:
            line = raw.decode("utf-8", "replace").strip()
            try:
                entry = json.loads(line)
            except ValueError:
                if line:
                    print("Caddy：" + line, file=sys.stderr, flush=True)
                continue
            if "certificate obtained successfully" in str(entry.get("msg")):
                print(f"HTTPS 证书已就绪：https://{host_port(host, cfg.port)}", flush=True)
            elif entry.get("level") in ("error", "fatal"):
                detail = f" · {entry['error']}" if entry.get("error") else ""
                print(f"Caddy：{entry.get('msg')}{detail}", file=sys.stderr, flush=True)
        caddy.wait()
        print(f"Caddy 已退出（退出码 {caddy.returncode}），HTTPS 不可用。", file=sys.stderr, flush=True)
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()
    print(f"访问地址：https://{host_port(host, cfg.port)}")
    print(f"HTTPS 由 Caddy 提供，配置文件：{config}")
    print(f"首次启动会申请证书，需要放行 80 端口（申请证书用）和 {cfg.port} 端口。", flush=True)
    return caddy


def print_credentials(cfg):
    print(f"共享目录：{cfg.root}")
    print(f"用户名：{cfg.user}")
    if os.environ.get("PASS"):
        print("密码：来自环境变量 PASS")
    elif cfg.password_generated:
        print(f"密码：{cfg.password}（已随机生成并保存到 {cfg.pass_file}）")
    else:
        print(f"密码：保存在 {cfg.pass_file}")
    if cfg.root == os.path.abspath(os.sep):
        print("警告：共享根目录是整个文件系统，任何登录的人都能读写所有文件。", file=sys.stderr)
    sys.stdout.flush()


def main():
    if "-h" in sys.argv or "--help" in sys.argv:
        print(HELP.format(version=__version__))
        return
    if "-v" in sys.argv or "--version" in sys.argv:
        print(__version__)
        return
    cfg = Config()
    Server.address_family = socket.AF_INET6 if ":" in cfg.host else socket.AF_INET
    try:
        httpd = Server((cfg.host, 0 if cfg.https else cfg.port), Handler)
    except OSError as err:
        sys.exit(f"无法监听 {cfg.host}:{cfg.port}：{err}")
    httpd.cfg = cfg
    caddy = None
    if cfg.https:
        backend = httpd.server_address[1]
        print(f"remote-fileshare {__version__} 已启动（HTTPS 模式，本机端口 {backend}）", flush=True)
        print_credentials(cfg)
        caddy = start_https(cfg, backend)
    else:
        print(f"remote-fileshare {__version__} 已启动：http://{cfg.host}:{cfg.port}", flush=True)
        if cfg.host in ("0.0.0.0", "::"):
            for ip in ["127.0.0.1"] + local_addresses():
                print(f"访问地址：http://{ip}:{cfg.port}", flush=True)
        print_credentials(cfg)
        if cfg.host not in ("127.0.0.1", "::1", "localhost"):
            def announce():
                host = public_host()
                if host:
                    print(f"外网访问：http://{host_port(host, cfg.port)}（需要在防火墙 / 安全组放行 {cfg.port} 端口；加 --https 可自动启用 HTTPS）", flush=True)
            threading.Thread(target=announce, daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        httpd.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        if caddy and caddy.poll() is None:
            caddy.terminate()
        httpd.server_close()


if __name__ == "__main__":
    main()
