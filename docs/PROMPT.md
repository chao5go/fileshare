# 原始提示词

remote-fileshare 最初叫 fileshare，是用下面这段提示词让 Claude Code 一次性生成的。现在的版本在此基础上又做了改进：密码改为随机生成并保存到文件，去掉了上传超时，增加了断点续传、预览、跨站请求防护、登录限流、Python 版和端到端测试。

想让 AI 从零生成一个同类工具，或者给它当参考，可以把下面整段复制给 Claude Code。完成后它会返回一个 `http://公网IP:8001` 的网址，在浏览器地址栏打开（必须以 http:// 开头，不是 https），输入用户名和密码即可使用。

```text
用 Node.js 给我写一个零依赖的单文件文件共享服务器 fileshare.js，只用内置模块（http/fs/path/crypto/child_process），不要 npm install 任何东西。

运行方式：node fileshare.js [共享目录]，默认当前目录，监听 8001 端口。

功能要求：
1. 全站 HTTP Basic Auth 保护：用户名 admin，密码写在文件开头的常量里（帮我随机生成一个），可用环境变量 PASS 覆盖。密码比对用 crypto.timingSafeEqual（先 sha256 再比，避免长度泄露）。
2. 网页目录浏览：文件夹在前按名排序，显示大小、修改时间；顶部面包屑导航，路径每一段可点击；有筛选输入框，输入关键字即时过滤当前列表；空目录显示引导提示。
3. 下载：点文件名直接下载（Content-Disposition attachment，文件名用 UTF-8 编码支持中文）；每个文件夹有"打包"链接，服务端 spawn 系统 tar 流式输出 .tar.gz，不占内存不落盘。
4. 上传：不要解析 multipart，用前端 XMLHttpRequest 逐个 PUT 原始文件体，服务端流式写入。支持多选文件、整个文件夹（webkitdirectory，保留目录结构，服务端 mkdir -p 父目录）、拖拽文件到页面上传（拖入时显示全屏虚线提示层，用进入/离开计数器防闪烁）。上传时显示 第n/共几个 + 百分比，页面顶部再加一条细进度条。反方向也要支持：dragstart 时设置 DownloadURL（Chromium 专有格式 "application/octet-stream:文件名:完整URL"），文件能从网页直接拖到桌面下载，文件夹拖出去下载 tar.gz；注意用一个标志位区分拖出和拖入，别让拖出误触发上传提示层。
5. 管理操作：新建目录按钮（POST ?mkdir）；每行有"改名"（POST ?rename=新名，输相对路径可实现移动）和"删除"（DELETE 方法，前端先 confirm，文件夹递归删）。操作链接平时半透明隐藏、悬停整行时浮现，触屏设备（hover:none）常显。
6. 安全：所有路径必须解码后 path.join 到共享根目录并校验不能越界（注意：共享根是 / 时前缀会变成 //，要先归一化再比，这是个经典坑）；禁止删除共享根目录本身；HTML 输出要转义文件名防注入。
7. 界面设计（中文界面，别做成千篇一律的后台模板）：
   - 左上角 logo：内联 SVG 画一个靛蓝圆角方块、里面一对白色上下箭头（象征上传/下载），favicon 用同款 data URI SVG；别用 emoji 或依赖字体的图标。
   - 配色用 CSS 变量：主色靛蓝（链接、文件夹、主按钮），警示色朱砂红（进度条、删除悬停、错误信息），并用 prefers-color-scheme 做明暗两套主题自动切换。
   - 字体：标题和正文用 system-ui 系统黑体，文件大小、时间、面包屑路径用 ui-monospace 等宽字体；文件/文件夹用两个内联 SVG 小图标区分。
   - 列表放在圆角卡片里，整行悬停高亮，窄屏（600px 以下）自动隐藏时间列，手机可用（viewport meta），尊重 prefers-reduced-motion。

写完后：用 nohup 后台启动（共享目录用当前目录，日志写到 fileshare.log），然后用 curl 实际验证：未登录返回 401、登录 200、PUT 上传后下载内容一致、?tar 打包能被 tar tzf 解开、../ 路径穿越被拒绝、mkdir/改名/删除各返回正确状态码，测试文件记得删掉。最后自动获取本机公网 IP（例如 curl -s ifconfig.me 或 curl -s ip.sb），把访问网址按完整的 http://公网IP:8001 形式，连同用户名、密码一起清楚地告诉我，方便我直接复制这个网址粘到浏览器地址栏打开使用。
```
