# NEBULA · 粒子音乐空间

一个带**粒子星云 / 空间纵深**视觉的网页流式音乐播放器，数据来自本地自建的网易云音乐 API 服务。

![status](https://img.shields.io/badge/status-working-6ee7ff) ![node](https://img.shields.io/badge/node-%E2%89%A518-339933)

## 它长什么样

- **封面粒子化**：专辑封面被采样成 **1.7 万颗粒子**，换歌时从宇宙深处飞回来重新拼成封面
- **节拍追踪**：低音冲击把粒子向外推出去，随后按弹簧感回位；画面还会朝鼠标方向轻微偏转
- **盒子空间**：粒子被关在一个发光线框盒子中央，内壁有浮尘、八个角有光点，盒子随低音"呼吸"
- **可转动视角**：拖拽 = 360° 环绕，滚轮 = 推拉，松手带惯性，闲置 2.5 秒后自动慢转
- **频谱光环**：128 段径向粒子贴在盒子内一圈，长度 = 频段能量、颜色 = 频率
- **节拍涟漪**：低音冲击时向外扩散一圈粒子（带节拍检测，不是死板的平均律动）
- **后期处理**：UnrealBloom 泛光 + 指数雾（纵深）

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

## 操作

| 操作 | 说明 |
|---|---|
| 搜索框 | 搜歌曲 / 歌手 / 专辑（回车） |
| 点列表 | 播放该曲 |
| **拖拽画面** | **360° 环绕旋转视角** |
| **滚轮 / 双指** | 推拉远近 |
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
