# NEBULA · 粒子音乐空间

一个带**粒子星云 / 空间纵深**视觉的网页流式音乐播放器，数据来自本地自建的网易云音乐 API 服务。

![status](https://img.shields.io/badge/status-working-6ee7ff) ![node](https://img.shields.io/badge/node-%E2%89%A518-339933)

## 它长什么样

- **封面粒子化**：专辑封面被逐像素采样成 **20 万颗粒子**（密度对齐歌词粒子），换歌时从宇宙深处飞回来重新拼成封面
- **节拍追踪**：低音冲击把粒子向外推出去，随后按弹簧感回位；画面还会朝鼠标方向轻微偏转
- **黑洞空间**：纯黑底 + 三层景深星场 + 盒内体积浮尘，转动视角时视差明显（边界线已按需求隐藏）
- **可转动视角**：拖拽 = 360° 环绕，滚轮 = 推拉（**能一路推进封面内部**，近看粒子粒粒分明），松手带惯性，闲置 2.5 秒后自动慢转（贴脸时不自动转）
- **节拍涟漪**：低音冲击时向外扩散一圈粒子（带节拍检测，不是死板的平均律动）
- **后期处理**：线性色调映射（黑就是黑）+ 高阈值泛光（只有最亮的核发光）

## 架构

```
浏览器  ──►  http://localhost:8080  （中间层 server.js，零依赖）
              ├─ /            静态页面（web/）
              ├─ /vendor/three/*   three.js 源码（直接从 node_modules 提供）
              ├─ /api/*       转发到网易云 API 服务（localhost:3000）
              ├─ /stream      解析歌曲真实地址后【同源】转发音频流（支持 Range）
              └─ /cover       同源转发封面图（WebGL 纹理需要同源）
                        │
                        ▼
              http://localhost:3000  （网易云 API 服务 api/）
```

**为什么音频必须自己转发？**
`createMediaElementSource()` 要求媒体资源是**同源或带 CORS**，否则 AnalyserNode 拿到的全是 0——粒子就死了。所以音频和封面都走自己的端口转发，同时也顺手解决了网易云 CDN 的 Referer / 防盗链问题。

## 快速开始

```bash
# 1. 装依赖
cd api && npm install          # 网易云 API 服务（约 550 个包）
cd .. && npm install           # three.js（前端）

# 2. 起网易云 API 服务（端口 3000）
cd api && node app.js

# 3. 起中间层 + 前端（端口 8080）
cd .. && node server.js

# 4. 打开
#    http://localhost:8080
```

改端口：`PORT=9000 node server.js`；指向别的 API 服务：`API_BASE=http://127.0.0.1:4000 node server.js`。

## 扫码登录（解锁 VIP / 无损音质）

点页面右上角 **未登录** → 手机**网易云音乐 App** 扫码 → 登录成功。

登录后：`无损` / `高解析度` 音质可选（VIP 账号只有登录后才有）、VIP/版权歌曲可播放、显示昵称与 VIP 标识。

**凭据怎么处理的**：登录 cookie 只存在服务端本地文件 `.cookie`（已在 `.gitignore` 里），
前端拿不到、不进聊天记录、不进仓库；日志里一律脱敏成 `cookie=***`。退出登录会删除该文件。

### 登录相关接口（都挂在 :8080 上，前端只跟自己的端口说话）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/login/qr` | 取二维码，返回 `{ok, key, img(base64 PNG), url}` |
| GET | `/api/login/qr/check?key=` | 轮询扫码结果：`800` 过期 / `801` 待扫码 / `802` 待确认 / `803` 成功（成功后服务端保存 cookie 并返回账号信息） |
| GET | `/api/login/status` | 当前登录态 `{ok, logged, profile, account}` |
| GET | `/api/logout` | 退出登录（删本地 cookie） |


## MV 粒子背景

放歌时会自动查这首歌有没有 MV（`/song/detail` 的 `mv` 字段），有就取地址并在**封面后方**用粒子播放：

- 视频经 `/mv?id=` **同源转发**（关键：跨域视频画到 canvas 会被污染，`getImageData` 直接抛 SecurityError，视频粒子就做不出来）
- 每颗粒子实时读 MV 画面的像素颜色：视频先缩到 **1280×720** 再取样，对应 **921600 颗粒子**（格子 0.336 单位 ≈ 1 CSS px），限频 30fps（CPU 开销约 1ms/帧）
- 粒子幕**宽度 430**（相机前 260 处，铺满视口并溢出；是视口宽度的约 1.5 倍）：跟随相机，每帧朝"相机前方 260、朝向相机"的目标位姿推进，但**带惯性**——转动视角时会被甩出去
  一点、并轻微滚转，停手后自动回正（直接挂在相机下会像贴在屏幕上，很生硬）
- **朝向必须绝对对齐相机**（`quat.copy(cam.quaternion)` 再叠一个受控小滚转）。早先用 `slerp` 累积会越转越歪，
  几个来回后整块翻过去（表现为"视角没倒，MV 先倒了"）
- 参数：位置跟随 `exp(-dt*12.0)`、最大甩出 45 单位、滚转上限 ±0.10（绕视线轴，屏幕内旋转）
- 滚转由**相机实际转动角速度**驱动（不依赖内部拖拽变量，任何方式转视角都有效），所以**四周都看得见**；用叠加混合，封面暗部会让 MV 透出来
- 热歌榜 60 首里约 30 首带 MV；没有 MV 或取不到地址（VIP/版权/地区限制）时静默不显示
- **MV 跟随歌曲进度**：按 `MV时长` 取模对齐（MV 常比歌曲短，取模后两边周期一致）；偏差小于 0.35s 不纠正以避免频繁 seek；拖动进度条与键盘跳转时强制对齐
- 亮度系数 `videoAlpha`（默认 **1.35**）；中央减光已移除（原来会在画面正中留下长方形暗区，现改为只保留边缘 18% 渐隐）、点径 **2.6~3.6**：实测定档——0.2 基本看不见、0.45 可见但会压住封面、0.7 完全压掉封面；
  另外把封面正后区域压到 **25%**（`central = 0.25 + 0.75*e/0.22`）——MV 再亮也不糊封面
- **坑**：视频元素不能用 `opacity: 0` 或完全移出屏幕——部分内核判定"不可见"就不解码帧，
  `drawImage` 会拿到全黑（表现为"粒子取不到色 → MV 看不见"）。正确做法：2×2 像素、几乎透明、压到最底层

接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mv/url?id=<mvid>` | 取 MV 真实地址（带登录 cookie） |
| GET | `/mv?id=<mvid>` | **同源转发视频流**（支持 Range，`video/mp4`） |

## 服务看护

第三方网易云 API 服务会偶发崩溃（实测崩过一次，播放器会整个失联），所以带一个看护：

```
services/run-api.cmd    起 API 服务（3000），日志 → logs/api.log
services/run-web.cmd    起中间层（8080），日志 → logs/web.log
services/watchdog.ps1   每 15 秒检查 3000/8080，掉了自动拉起 → logs/watchdog.log
```

```powershell
powershell -ExecutionPolicy Bypass -File services\watchdog.ps1
```

## 操作

| 操作 | 说明 |
|---|---|
| 搜索框 | 搜歌曲 / 歌手 / 专辑（回车） |
| 点列表 | 播放该曲 |
| **拖拽画面** | **360° 环绕旋转视角** |
| **滚轮 / 双指** | 推拉远近，**一直推可以钻进封面正中间**（近处自动限制点尺寸 + 压暗，保证粒子一颗颗看得清，不糊成一片白）|
| **双击画面 / R** | 视角复位 |
| 我的音乐标签 | 登录后看你的歌单（含「我喜欢的音乐」） |
| 空格 | 播放 / 暂停 |
| ← → | 快退 / 快进 5 秒 |
| Shift + ← → | 上一首 / 下一首 |
| ↑ ↓ | 音量 |
| F | 聚焦搜索框 |

调试：`http://localhost:8080/?debug=1` 左下角显示封面粒子数 / 帧率 / 视角 / 能量。

## 已知限制

- **音质**：匿名调用只能拿到标准音质（128k）。`极高`/`无损` 需要登录 cookie（可扩展扫码登录）
- **版权/VIP 歌曲**：没有可用地址时会提示并自动跳到下一首
- 首次播放需要一次点击（浏览器自动播放策略），这是正常行为

## 文件

```
server.js            中间层：静态服务 + API 代理 + 音频/封面同源转发
web/index.html       页面结构 + three.js importmap + 错误兜底
web/css/style.css    玻璃拟态 UI
web/js/scene.js      粒子/星云/频谱/涟漪/泛光（视觉引擎）
web/js/app.js        播放逻辑、歌词同步、Web Audio 频谱、快捷键
api/                 网易云音乐 API 服务（第三方，@neteasecloudmusicapienhanced/api）
logs/server.log      中间层运行日志
```

## 调试开关

两个浮层默认**不显示**，只有带参数时才出现（日常使用请用干净的 `http://localhost:8080/`）：

| 参数 | 作用 |
|---|---|
| `?debug=1` | 左下角数据条：粒子数 / 帧率 / 视角 / 频谱能量 / MV 状态 |
| `?probe=1` | 左上角布局探针：列出歌词那一带的 DOM 元素与几何信息（排查"屏幕上有个奇怪东西"用） |
| `?probe=1&stage=<歌曲id>` | 诊断台：直连 scene.js 挂上指定歌曲的封面/歌词/MV，绕过 UI，用于逐帧比对渲染 |
| `/diag.html?id=<mvid>` | MV 流体检页：把 `/mv` 流转成画面并量亮度（分辨"MV 没画面"还是"画面本身暗"）|

## License

MIT

## 空间盒子（1 / 2 切换）

右下角「盒子」按钮**循环切换 1 → 2 → 3**，状态存在 localStorage：

| | 盒子 1 · 自由视角 | 盒子 2 · 电影镜头舞台 | 盒子 3 · 无封面 |
|---|---|---|
| 相机 | 拖拽环绕 + 松手惯性 + 闲置慢转 | **电影镜头**：6 组机位按节拍硬切（最短间隔 6 秒），到位后缓慢推拉摇移；用户拖动时立刻让位，松手 3.5 秒后接管 |
| 氛围 | 纯黑宇宙、雾 0.0024、泛光 0.46 | 舞台感：曝光 1.16、雾 0.0014、泛光 0.55 且阈值抬高到 0.62 |
| 内容 | 封面 + 歌词 + MV | **无 MV**（只有封面）| **无封面**：MV 铺满、歌词在其下方 |

两个盒子**共用**同一套歌词渲染，照 Mineradio 的歌词视觉语言重写（非移植代码）：

- **星河流 → 聚成字**：每句歌词先是一条贴着本行文本尺寸流动的星河带（散点是河带而非随机球壳，
  前 42% 的 morph 阶段沿河漂流、之后聚成字），星河期亮度保持可见（太淡会消失在背景星场里）
- **白字芯 + 青色辉光**：字芯提白保证清晰，外缘叠 `rgb(143,233,255)` 青色辉光（对齐它的辉光色）
- **进度高光**：跟着唱到的位置走（暖金色带，`abs(vAlong - uProgress)` 的窄带），由 LRC 时间驱动
- **微光扫过**：`pow(max(0,sin((vAlong - y*0.10 + t*0.82)*26)),26)` 斜向细线扫过文字
- **强拍加暖**：低音冲击时整行微微加暖（它的太阳泛光色）
- 总亮度仍与旧版持平：4 倍粒子重叠后的叠加值必须低于泛光阈值，否则整行糊成一条白光（踩过这个坑）

## 多音源：网易云 / QQ 音乐 / 酷狗音乐

面板顶部可切音源（localStorage 记忆）。三家的接口形态差异很大，所以**在中间层把 QQ/酷狗
归一化成"网易云的数据结构"**再返回：前端（列表渲染、播放、歌词、粒子封面）整套逻辑不用分叉，
这也是"效果和接入网易云一样"的关键。

| | 网易云 | QQ 音乐 | 酷狗音乐 |
|---|---|---|---|
| 搜索 | ✓ 本地 API 服务(:3000) | ✓ `client_search_cp` | ✓ `song_search_v2` |
| 播放取流 | ✓ 已登录 | ✓ `musicu.fcg` vkey 流程 | ✓ `m.getSongInfo` |
| 歌词 | ✓ | ✓ `fcg_query_lyric_new` | ✓ `krcs` + `lyrics/download` |
| 粒子封面 | ✓ | ✓ gtimg 800x800 | ✓ imge.kugou.com 480 |
| 榜单 | 我的歌单（需登录）| ✓ 热歌/飙升/新歌榜 | ✓ TOP500 等 |
| MV | ✓ | ✗ 未接入 | ✗ 未接入（m3u8 需 hls.js）|

### 已知限制（实测数字）

- **原版付费曲拿不到播放地址**：QQ 返回 `errtype=104003`、酷狗返回 `err=需要付费`，
  中间层把原因原样传回，前端提示"换一首"。实测免登录可播率：**QQ 12/30、酷狗 7/20**，
  能播的多是翻唱 / Live / 版本曲。**登录自己的账号后能播率会大幅提高**（取流接口支持 Cookie）。
- QQ / 酷狗 读不到"我的音乐"（需要各家登录），面板里用官方榜单顶上，保证有内容可点。
- 切音源会清空当前队列：两家 id 语义不同（QQ 是 songmid、酷狗是 hash），混着播会取错歌。

### 实现位置

- `sources.js`：两个音源适配器（搜索 / 取流 / 歌词 / 榜单 / MV），输出网易云结构
- `server.js`：`/api/sources`、`/api/search|lyric|playlist/detail?source=` 分流，
  `/stream?source=` 现取现转（QQ/酷狗的直链有时效，不能缓存）
- 前端：`#srcRow` 三个按钮 + `state.musicSource` + `srcParam()` 拼参数

### QQ / 酷狗 的登录（凭据导入）

**怎么拿**（每家 30 秒）：

| | QQ 音乐 | 酷狗 |
|---|---|---|
| ① 登录站点 | `y.qq.com`（能看到自己歌单才算真登录）| `www.kugou.com` |
| ② 打开 | `F12 → Application → Cookies → 选中该站点` | 同左 |
| ③ 关键键 | **`qqmusic_key`**（有时叫 `qm_keyst`）+ `uin` | **`token`** + `userid` |
| ④ 复制 | 选中整个表格多行 `Ctrl+C`，或右键 `Copy all as JSON` | 同左 |

粘贴什么形态都行：单行、`Cookie: ...` 整行、多行、JSON 数组、DevTools 表格复制（制表符）、带外层引号
—— 都实测通过。缺关键键时会直说原因（"没有 qqmusic_key，可能从 qq.com 复制的"）。

原来的段落：


播放入口认的是 Cookie 里的密钥（QQ 是 `qqmusic_key`、酷狗是 `token`），拿到后 VIP 曲才取得到流。

面板：切到 QQ/酷狗 后点右上角账号按钮 → 粘贴 Cookie → **保存并校验**。

**校验是真的**：中间层会拿一首 VIP 曲（"晴天"原版）实测取流，取不到就判无效并拒绝保存——
不会出现"显示登录成功其实还是播不了"的假象。接口 `POST /api/source/auth?source=qq|kugou`，
凭据存 `.cookie-qq` / `.cookie-kugou`（已进 .gitignore），接口只回显键名不回显值。

**为什么不是扫码**（实测结论，别重复踩）：
- QQ：扫码链路本身是通的（`ptqrshow` 拿 PNG + `qrsig`，`ptqrtoken = hash33(qrsig)`，
  轮询返回 `ptuiCB('66',...,'二维码未失效。')`）。但**扫完之后的最后一步**——把 QQ 互联凭证
  换成 QQ 音乐的播放密钥——需要它前端那段混淆签名（zzc sign），这段没实现，
  所以只做扫码并不能提高能播率，宁可不做这种"看着能登其实没用"的功能。
- 酷狗：二维码接口 `login-user.kugou.com/v2/qrcode` 一直返回 `error_code 20010`。
  公开实现里提到要先 `/register/dev` 注册设备拿 `dfid`（且 mid 要用 uuid 的 md5 转大整数），
  但该路径现在 404，尝试 6 轮未打通。

## 桌面版（Electron）

把浏览器里那套原样装进一个原生窗口，不用再手动起服务。

```bash
cd desktop
npm install          # 首次装 electron（国内的坑见下）
npm start            # 直接跑
npm run dist         # 打包 NSIS 安装包 → ../dist/NEBULA-Setup-0.1.0.exe
```

**设计取舍**

- **界面零重写**：`web/` 原样作为渲染层，窗口只是把 `http://127.0.0.1:8080` 装进 BrowserWindow
- **中间层同进程**：主进程直接 `require('../server.js')`，不另起进程
- **网易云 API 用 Electron 自带的 Node 当子进程**（`ELECTRON_RUN_AS_NODE=1`），
  打包后不依赖用户自己装 Node
- **端口复用**：8080/3000 已有实例在跑就直接复用，不抢端口（开发时常见）
- **单实例锁**：重复双击只把已有窗口提到前面，不会开出第二个播放器

**用户数据全在 D 盘**（`NEBULA_DATA` 可改，默认 `D:\NebulaPlayer`）：

```
D:\NebulaPlayer\
  data\        登录 Cookie（.cookie / .cookie-qq / .cookie-kugou）、截图
  userData\    Chromium 缓存
  logs\  session\
```

必须外置的原因：打包后应用文件在 `asar` 里**只读**，Cookie 和截图写不进去；
同时符合「C 盘不留东西」的要求。

**国内装 electron 的坑（踩过）**：新版 npm 有安装脚本白名单，electron 的 postinstall
（真正下载二进制那步）会被拦下，表现为"包装上了但 electron.exe 不存在"。需要：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install-scripts approve electron       # 放行 postinstall
npm rebuild electron --foreground-scripts  # 重新触发下载
```

### 打包成安装包

```bash
bash desktop/build-win.sh          # 一步到位（装构建器 → 打包 → 列出产物）
# 或
cd desktop && npm run dist
```

`build-win.sh` 里那几个环境变量不是可选项，缺了就会卡在下载：

| 变量 | 作用 | 不设的后果 |
|---|---|---|
| `ELECTRON_MIRROR` | electron 运行时二进制 | 从 GitHub 拉，失败 |
| `ELECTRON_BUILDER_BINARIES_MIRROR` | NSIS / winCodeSign 等辅助二进制 | 从 GitHub 拉，失败 |
| `CSC_IDENTITY_AUTO_DISCOVERY=false` | 跳过代码签名 | 没证书还去要签名，多下载且报错 |
| `ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE` | 下载缓存放 D 盘 | 落在 C 盘用户目录 |

镜像地址（实测可用）：`https://registry.npmmirror.com/-/binary/electron-builder-binaries/`
（注意不是 `npmmirror.com/mirrors/...`，那个会 302 到失败）

产物：

```
dist/
  NEBULA-Setup-0.1.0.exe    ← 安装包（NSIS，可选安装目录）
  win-unpacked/NEBULA.exe   ← 免安装版，直接双击就能跑（验证/自用推荐）
```

**体积优化（待做）**：`api/` 目录 188M，其中一半是开发依赖
（typescript 23M、prettier 9.7M、eslint 相关…），运行时用不到。
打包前 `cd api && npm prune --omit=dev` 可以显著瘦身。

### 安装包自测（一条命令跑完整闭环）

```bash
bash desktop/test-installer.sh              # 静默安装（验默认目录）→ 验证 → 启动
bash desktop/test-installer.sh --uninstall  # 卸载 → 验证清理
```

实测结果（2026-10-04）：

| 检查项 | 结果 |
|---|---|
| 默认安装目录 | `D:\NEBULA` ✓（**不是 C 盘**，靠 `installer.nsh` 覆写注册表 InstallLocation）|
| 桌面快捷方式 / 开始菜单 | ✓ 都建了，卸载时都清掉 |
| 注册表面板登记 | ✓ `DisplayName=NEBULA 0.1.0` + QuietUninstallString |
| 安装版启动 | ✓ 自拉起中间层 + 网易云 API，歌单可载入、正常播放 |
| 卸载 | ✓ 程序/快捷方式/注册表全清，安装目录也删掉 |
| 用户数据 | ✓ 保留（`deleteAppDataOnUninstall: false`），重装不用重新登录 |

**几个只会在实机上暴露的坑**：

- **默认装到 C 盘**：electron-builder 在 `perMachine:false` 时默认 `%LOCALAPPDATA%\Programs\...`，
  顺手点下一步就进 C 盘。必须用 `nsis.include` + `preInit` 宏覆写注册表里的 `InstallLocation`。
- **卸载器不能通过 `cmd /c "\"路径\""` 调**：引号会被吃掉，报「不是内部或外部命令」而**静默什么也没做**。
  直接从 bash 调用 `"/d/NEBULA/Uninstall NEBULA.exe" /currentuser /S` 才有效。
- **卸载是异步的**：卸载器会把自己复制到临时目录再执行，所以调用后要轮询文件消失，不能立刻判断。
- **后台命令退出会带走子进程**：用 `bash xxx.sh &` 方式启动 GUI 程序，脚本一结束进程树就被清掉，
  表现为「应用自己退出了」——排查时容易误判成崩溃。
- **登录态与数据目录绑定**：安装版的数据目录是 `D:\NebulaPlayer\data`，与开发版（项目根）不同。
  实机上看到「已登录」是因为它复用了开发环境跑着的服务；**独立运行需要在新数据目录里登录一次**
  （或把 `.cookie*` 复制过去）。

### 已知噪音：打包版启动时的 zstd 解压失败（不影响功能）

打包版日志里会出现：

```
Error: unexpected EOF
    at decompress (.../api/node_modules/fzstd/lib/index.js:634:21)
```

**根因**：`api/util/zstd.js` 里有个分支 ——

```js
const hasNative = typeof zlib.zstdCompressSync === 'function'
return hasNative ? zlib.zstdDecompressSync(buf) : Buffer.from(fzstdDecompress(buf))
```

Node ≥22.15 有原生 zstd（走原生分支）；**Electron 自带的是 Node 20**，于是走 fzstd 分支。
某些**合法的 zstd 流** fzstd@0.1.1 解不了，原生解码器却能解 —— 所以**这个错只在打包版出现，
开发环境（系统 Node 26）从来没见过**。这解释了为什么它看起来像"偶发网络抖动"，其实是确定性的。

**为什么不影响功能**：报错之后 API 照常启动，`/search`、歌单、取流、歌词、MV 全部实测 200。
（那条"Successfully registered anonimous token"日志本身也有点误导——上游把它打在了真正发请求**之前**。）

**处理**：`services/fix-fzstd.sh` 已把它从"抛异常"降级为"记一条警告后按原文返回"，
既不崩也不静默吞掉线索。想彻底消除需要换一个更完整的 zstd 解码器（fzstd 已是最新版，没有可升级的）。

## 手机 / 安卓

### 架构决定：手机是瘦客户端，后端留在电脑上

播放器的**后端跑不到手机上**——网易云接口要 weapi/eapi 加密、QQ/酷狗要走服务端直连和 Cookie 中转。
所以安卓版不是"把后端塞进 APK"，而是**手机连你的电脑**（中间层监听 `0.0.0.0`，本来就是对外开放的）。

- 家里同一个 Wi-Fi：`http://<电脑IP>:8080/`
- 在外面：走 ZeroTier，用电脑的 ZeroTier 地址访问
- 前提：电脑开着、中间层在跑（看护脚本会盯着）

### 画质分档（手机能不能用，全看这个）

桌面版是 MV 92 万 + 封面 37 万 ≈ **140 万颗粒子**，桌面 GPU 轻松 300fps，手机上直接变幻灯片。
按设备自动判定，也可以用 `?q=low|mid|high` 强制：

| 档位 | MV 采样 | MV 粒子 | 封面采样 | 泛光 | 像素比 | 触发 |
|---|---|---|---|---|---|---|
| low | 480×270 | 12.96 万 | 448 | 半分辨率 | 1.5 | 手机/平板（自动） |
| mid | 768×432 | 33.2 万 | 640 | 全分辨率 | 2 | 手动 |
| high | 1280×720 | 92.2 万 | 900 | 全分辨率 | 2 | 桌面（自动） |

两点设计上的讲究：
- **泛光不能整个关掉**。低画质档一开始是把泛光关了，实测画面明显发灰 —— 那是底线，不能牺牲。
  改成**半分辨率跑泛光**（UnrealBloom 内部本来就是多级降采样+模糊，半分辨率视觉几乎无差），开销降到约 1/4。
- **点径跟着格子缩放**，所以降采样只是"颗粒变粗"，不是"画面糊掉"：远看构图、亮度、层次都一致。

### 触摸手势

触摸设备没有 `wheel` 事件，原来手机上没法缩放 → 补了双指捏合（分开=拉近、捏合=拉远），
双指时自动停掉单指拖拽旋转，避免两个手势打架。

### 添加到主屏幕（PWA）

`web/manifest.webmanifest` + `web/icons/`（192/512/180，脚本 `services/make-pwa-icons.py` 可重生成）。
注意 `server.js` 的 MIME 表里给 `.webmanifest` 指定了 `application/manifest+json` ——
Chrome 对清单的 MIME 是**硬校验**，返回 `application/octet-stream` 会直接拒绝清单，装不上。

### 全屏（HTTP 下的关键，不是锦上添花）

**HTTP 访问装不了真 PWA**：Chrome 的「安装应用」要求 HTTPS（或 localhost），放在 `http://192.168.x.x:8080/`
这种地址上只能"添加到主屏幕"生成一个普通书签，打开还是带地址栏的浏览器。

但 **Fullscreen API 不受 HTTPS 限制** —— 所以手机端的观感靠自建全屏拿到：
控制栏右侧的全屏按钮（或按 `F`），带 `navigationUI:'hide'`（安卓 Chrome 认这个参数，用来藏状态栏）。
选择记在 localStorage，下次进来自动恢复到全屏（全屏必须由用户手势触发，所以挂在"第一次点击/触摸"上，
和用户本来就要点播放这个动作重合，不额外打扰）。

屏幕常亮的 Wake Lock 同样需要 HTTPS，代码里 try/catch 了 —— 现在不生效，**万一以后挂到 HTTPS 就自动生效**。

### 手机访问（二维码）

`python services/make-qr.py` 生成 `dist/qr/nebula-lan.png` 和 `nebula-zerotier.png`。
不依赖 PIL（取 QR 矩阵后自己写 PNG），生成后有往返比对校验（像素级对比 + 三个定位角），
因为自己写编码器就有写坏的风险，不能只看"文件生成了"。

## 部署到服务器（24 小时那台）

播放器最终跑在 DESKTOP-87P9U2C 上（那台 7x24 开机、不睡眠），本机只用来开发。

结构（全在 D 盘）：`D:
ebula` 代码 + `D:\Apps
ode
ode.exe` 运行时 + `D:\Apps\cloudflared\cloudflared.exe` 隧道。

**开机自启用 SYSTEM 计划任务**（照搬飞书网关那套模式，session 0、不依赖登录）：
`NEBULA_Services` → `powershell -File D:
ebula\services\server-watchdog.ps1`，
由看护负责拉起 API(3000) + 中间层(8080) + 公网隧道。注册用 `services/server-register-task.ps1`。

### 迁移时踩的坑（都很典型）

- **`tar --exclude='dist'` 会排除任意层级的 dist**：本意是排除根目录那个 793MB 的 Electron 构建产物，
  结果把 `api/node_modules/axios/dist/` 一起排除了 → 服务器上 API 报
  `Cannot find module .../axios/dist/node/axios.cjs`。压缩包里 4379 项、解出来 3773 项。
  **必须锚定成 `--exclude='./dist'`**。教训：打包后要核对压缩包内的关键文件，不能只看包生成了。
- **同名文件互相覆盖**：服务器版看护最初也叫 `watchdog.ps1`，重新解包时被仓库里的 PC 版覆盖回去，
  于是又用裸 `node`（服务器不在 PATH）→ 服务起不来。改成 `server-watchdog.ps1` 独立命名后根治。
- **SSH 到 Windows 的坑**：默认 shell 是 PowerShell（不是 cmd），`cd /d x && y` 会报 InvalidEndOfLine；
  PowerShell 往原生程序喂二进制 stdin 会损坏数据（所以用 scp 传文件而不是 tar 管道）；
  走 SSH 的 stdout 是 UTF-16/GBK，中文全乱码 —— **可靠做法是让远端写文件再 scp 抓回来读**。
- **`Get-CimInstance ... -like '*watchdog*'` 自杀**：命令行里同时出现过滤词和脚本路径时，
  SSH 会话自身的进程也被匹配到并被杀掉，导致后续命令根本没执行。杀进程的过滤条件要避免匹配到自己。
- **`Set-Content -Encoding UTF8` 会写 BOM**：生成的 .tunnel-url 带 BOM → 二维码里编进一个不可见字符
  → 扫出来打不开。读取时用 `utf-8-sig`。

## 安卓版（APK）

`android/` 目录，产物 `android/build/NEBULA.apk`（约 30KB）。

### 为什么是"瘦客户端 + 可改服务器地址"

后端跑不到手机上（网易云要 weapi/eapi 加密、QQ/酷狗要服务端直连中转），所以 App 就是一个
专用 WebView，指向你自己的服务器。**因为 Cloudflare 快速隧道每次重启地址都会变**，
所以地址必须能在应用内改：首次启动会弹设置框，之后**长按画面任意位置**随时修改，记在本地。

### 构建：刻意不用 Gradle

Gradle 本体 + Android 的 maven 依赖在国内网络下拉起来非常痛苦。而 APK 构建本质就五步，
SDK 的 build-tools 里全都有：`aapt2 编译资源 → aapt2 链接 base.apk → javac → d8 转 dex →
装进 apk`，再 `zipalign` + `apksigner`。`android/build.sh` 把这条路走通，**全程零网络依赖**。

```bash
bash android/setup-toolchain.sh   # 装 JDK17 + Android SDK（build-tools 34 / platform 34）到 D 盘
bash android/build.sh             # 出 android/build/NEBULA.apk
```

工具链位置：`D:\Apps\jdk17`、`D:\Appsndroid-sdk`（都按用户要求装 D 盘）。

### 构建踩的坑

- **`resources.arsc` 必须保持 STORED（不压缩）且对齐**（API 30+ 硬要求）。用 Python 往 APK 里塞
  classes.dex 时如果按 ZIP_DEFLATED 重写所有条目，会破坏这一点导致装不上 —— 必须沿用每个条目原本的
  `compress_type`。
- **javac / d8 是 Windows 原生程序，读不了 MSYS 的 `/d/...` 路径**。源文件列表必须用 `pwd -W` 的写法。
- **不要把报错重定向到 /dev/null 或用 grep 过滤**：这轮因此白折腾一次（javac 失败但被 `|| true` 吞掉，
  最后表现为 d8 "没产出 dex"，看不出真实原因）。
- **JDK 下载**：清华镜像里文件名是 `...17.0.20.1_1.zip`，用错版本号会 404；`aka.ms` / 北外镜像不通，
  中科大/南大的路径结构与清华不同。
- 判断"APK 能不能装"要验四件事：`apksigner verify`（签名）、`aapt2 dump badging` 里有
  `launchable-activity`（否则装了点不开）、`resources.arsc` 是 STORED、以及**从公网下载回来做 sha256 比对**
  （截断的安装包是最坑的失败方式）。
