# fileshare

零依赖、单文件的网页文件共享服务器。一个 `fileshare.js`，有 Node.js 就能跑，不需要 `npm install`。

适合这样的场景：你在本地电脑上通过 Claude Code、Codex、opencode 等 **远程 AI agent** 操作一台境外服务器，需要把图片、文档、整个文件夹传给 agent 处理，或者把 agent 生成的结果拿回本地。

> ⚠️ **特别提醒**：服务器在境外时，直接在 VS Code / 终端里拖拽上传大文件会很慢，还容易中断。传大文件、整个文件夹，建议用 fileshare 的网页上传：浏览器直连服务器，带进度、速度和剩余时间，体验好很多。

## 功能

- **全站密码保护**：HTTP Basic Auth，密码比对防时序攻击，连续登录失败自动锁定 IP
- **目录浏览**：面包屑导航、即时筛选、文件夹在前、大小和修改时间、明暗主题自动切换、手机可用
- **上传**：多选文件、整个文件夹（保留目录结构）、拖拽到页面上传；流式写入不占内存，显示进度、速度、剩余时间；无超时限制，慢速线路传几个小时也不会被掐断
- **下载**：点文件名直接下载（中文文件名正常），支持断点续传；文件夹一键打包成 `.tar.gz` 流式下载，不落盘；在 Chrome / Edge 里可以把文件直接从网页拖到桌面
- **预览**：图片、PDF、音视频、文本/代码在新标签页打开（放在沙箱里，上传的网页文件无法在本站执行脚本）
- **管理**：新建目录、改名/移动（不会覆盖已有文件）、删除
- **给 AI agent 用**：每个文件都有「复制路径」，复制的是它在服务器上的绝对路径，直接粘贴给 agent 即可

## 快速开始

需要 Node.js 18 及以上版本，以及系统自带的 `tar`（打包下载功能使用）。

```bash
# 下载（也可以 git clone 整个仓库）
curl -fsSLO https://raw.githubusercontent.com/<你的用户名>/fileshare/main/fileshare.js

# 在要共享的目录里启动（默认共享当前目录，端口 8001）
node fileshare.js /path/to/share
```

首次启动会随机生成密码，打印在终端里，并保存到 `~/.config/fileshare/password`，之后重启密码不变。

然后在浏览器打开 `http://服务器公网IP:8001`，用户名 `admin`，密码见上。查看本机公网 IP：`curl -s ifconfig.me`。

### 后台运行

```bash
nohup node fileshare.js /path/to/share > fileshare.log 2>&1 &
pkill -f fileshare.js   # 停止
```

长期使用建议用 systemd 托管，开机自启、崩溃自动重启，示例见 [`contrib/fileshare.service`](contrib/fileshare.service)。

### 配置

全部通过环境变量设置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8001` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，只想本机访问可设为 `127.0.0.1` |
| `FS_USER` | `admin` | 登录用户名 |
| `PASS` | 随机生成 | 登录密码，设置后不再读写密码文件 |
| `PASS_FILE` | `~/.config/fileshare/password` | 自动生成的密码保存位置；改密码可以直接编辑它后重启 |

```bash
PORT=9000 PASS='一个足够长的密码' node fileshare.js ~/share
```

## 配合 AI agent 使用

- **把文件交给 agent**：网页上传后，点该文件的「复制路径」（或页面上方的「复制当前目录路径」），把路径粘贴进对话，例如「帮我看看 /root/share/截图.png」。
- **把 agent 的产出拿回来**：让 agent 把结果写到共享目录里，刷新网页即可下载；整个文件夹点「打包」。
- **让 agent 用命令行操作**（agent 在另一台机器上时）：

```bash
U='admin:你的密码'; S='http://服务器IP:8001'
curl -u "$U" -T report.pdf "$S/报告/report.pdf"        # 上传（自动创建目录）
curl -u "$U" -o report.pdf "$S/报告/report.pdf"        # 下载
curl -u "$U" -C - -o big.iso "$S/big.iso"               # 断点续传下载
curl -u "$U" "$S/报告/?tar" | tar xz                    # 打包下载整个目录
curl -u "$U" -X POST -G --data-urlencode "mkdir=新目录" "$S/"             # 新建目录
curl -u "$U" -X POST -G --data-urlencode "rename=归档/a.txt" "$S/a.txt"   # 改名 / 移动
curl -u "$U" -X DELETE "$S/a.txt"                                          # 删除
```

路径里的中文可以原样写；`?` 后面的参数含中文时，Node 会直接拒绝请求，所以要像上面那样用 `-G --data-urlencode` 编码。

## HTTP 接口

| 请求 | 作用 | 成功状态码 |
| --- | --- | --- |
| `GET /目录/` | 目录网页 | 200 |
| `GET /文件` | 下载（支持 `Range`） | 200 / 206 |
| `GET /文件?preview` | 内联预览 | 200 |
| `GET /目录/?tar` | 流式打包下载 `.tar.gz` | 200 |
| `PUT /路径/文件` | 上传原始文件体，自动创建父目录，同名文件会被覆盖 | 201 |
| `POST /目录/?mkdir=名称` | 新建目录，名称可以包含 `/` | 201 |
| `POST /路径?rename=新名称` | 改名；新名称相对当前所在目录，可含 `/` 实现移动；目标已存在返回 409 | 204 |
| `DELETE /路径` | 删除文件，或递归删除文件夹 | 204 |

## 安全说明

- 这个服务能读写共享目录里的**所有文件**，请使用足够长的随机密码（默认生成的就是）。
- 不要把共享目录设成 `/`，尤其是在公网服务器上。
- Basic Auth 走的是明文 HTTP，密码和文件在网络上都不加密。在不可信网络里使用时，建议放到 Caddy / Nginx 后面加 HTTPS，或者通过 SSH 隧道访问：`ssh -L 8001:127.0.0.1:8001 服务器`，然后打开 `http://127.0.0.1:8001`。
- 已经做了的防护：路径穿越与符号链接越界校验、禁止删除共享根目录、文件名 HTML 转义、拒绝跨站写请求（CSRF）、预览内容放进 CSP 沙箱、登录失败限流。

## 常见问题

**打不开网页？** 先检查地址栏：浏览器经常自动把 http 改成 https，这个服务只有 http，必须完整输入 `http://IP:8001`。再检查云服务器的安全组 / 防火墙有没有放行 8001 端口。还打不开就用手机流量试一下，能打开说明是你所在的网络拦截了。

**传到一半断了？** 网页上传是逐个文件进行的，已经传完的文件不受影响，重新选择剩下的文件继续即可。下载中断可以用浏览器的「继续」或 `curl -C -` 续传。

**怎么换密码？** 设置 `PASS` 环境变量，或者编辑 `~/.config/fileshare/password` 后重启服务。

## 开发

```bash
npm test   # 在临时目录启动真实服务器跑端到端测试，无需安装任何依赖
```

[`docs/PROMPT.md`](docs/PROMPT.md) 是这个项目最初的 Claude Code 提示词，可以用它让 AI 从零生成一个同类工具。

## 许可证

[MIT](LICENSE)
