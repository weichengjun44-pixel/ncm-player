# 进度存档

> 最后更新：2026-10-04 深夜。**下次继续时先看这个文件。**

## 一、现在是什么状态（都是实测验证过的）

播放器跑在 **DESKTOP-87P9U2C**（24 小时开机那台，SYSTEM 任务 `NEBULA_Services`，
不依赖登录）。开发机（w3032）只用来写代码，不承担服务。

| 项目 | 状态 |
|---|---|
| 浏览器访问 | ✓ 手机直接开就能用（全屏、粒子、歌词星河都正常） |
| 安卓 APK | ✓ 已安装可用（Wi-Fi 时可长按画面改服务器地址） |
| 前端模块图 | ✓ 18/18 资源全部 200，无 404 |
| 后端接口 | ✓ healthz / api/search / api/playlist / api/sources 全 200 |
| 音频流 | ✓ 206 + Range 透传（进度条可拖） |
| 服务器工具链 | ✓ JDK17 + Android SDK 都在 `D:\Apps`，能自己构建 APK |
| 服务器源码 | ✓ 含 android/ desktop/ 与 .git 完整历史（`D:\nebula`） |

**当前隧道地址（重启会变，这是唯一脆弱点）**：
`https://herb-glen-inherited-panels.trycloudflare.com`
APK 下载：同地址 + `/NEBULA.apk`

详细架构与踩坑记录见 `README.md`（含「服务器自给自足」「安卓版」「部署到服务器」三节）。

## 二、下次第一件事：买域名 + 命名隧道（把地址永久固定）

用户已经同意买。**等他买完域名后从这里继续**：

1. **用户买域名**（腾讯云/阿里云，`.top`/`.xyz` 约 ¥10~30/年）
   —— 支付与实名认证必须他本人做，不要代劳
2. **用户注册 Cloudflare 免费账号**（不用绑卡）
3. **域名 NS 指到 Cloudflare**（在腾讯云/阿里云控制台改 nameserver，给具体值）
4. **服务器上跑授权**：`cloudflared tunnel login` → 把链接发给用户点「允许」
   （凭证会落到服务器上，不需要在那台机器上开浏览器）
5. **建命名隧道 + 绑子域名**（如 `nebula.域名`）→ 改 `services/server-watchdog.ps1` 的隧道方式
6. **重新构建 APK**（把固定地址写进 `MainActivity.java` 的 `DEFAULT_URL`）+ 出新二维码

预期收益：APK、浏览器书签、二维码全部永久有效，还能把网址发给别人用。

## 三、已知缺口（不着急，列着免得忘）

- **QQ / 酷狗 MV 未接入**：QQ 的 `musicu.fcg` MV 模块名试了 4 个变体都没通；
  酷狗是 m3u8，需要 hls.js。目前只有网易云的 MV 能做粒子幕。
- **免登录可播率**：QQ 12/30、酷狗 7/20（能播的多是翻唱/Live/版本曲）。
  提升要靠凭据导入（已实现）或扫码（酷狗被 `error_code 20010` 挡住）。
- **桌面版 Electron 安装包**：`winCodeSign-2.6.0.7z` 解压符号链接失败（Windows 无特权），
  但安装包最终能出（125.4MB）。仓库 `dist/` 里有免安装版。
- **隧道线路质量**：免费 Cloudflare 在国内时好时坏，用户实测目前可用。
  若以后要稳，可换国内云主机中转（学生机约 ¥99/年）。

## 四、常用命令速查

```bash
# 部署到服务器（白名单式，含自检与核对）
bash services/deploy-to-server.sh

# 前端模块图体检（手机上没控制台，这是最快的定位手段）
python services/check-module-graph.py

# 在服务器上构建 APK（日志在服务器 logs/apkbuild.log）
ssh desk "& 'D:\nebula\services\build-apk.cmd'"

# 手机端报错（前端 boot.js 会把错误 POST 回服务器，落在这个文件）
ssh desk "Get-Content D:\nebula\client.log -Tail 30"

# 当前隧道地址
ssh desk "Get-Content D:\nebula\.tunnel-url"
```

## 五、今天这一轮踩过的坑（教训已进 README 与技能库）

1. **`tar --exclude='./node_modules'` 误伤**：排掉了运行必需的 `node_modules/three`
   → 前端模块图断裂 → 浏览器只报「js/app.js 加载失败」，真因藏了两层。
   **结论：部署搬运要用白名单，不要用排除法。**
2. **`resources.arsc` 必须保持 STORED**（API 30+ 硬要求）：用 Python 重写 APK 时
   若按 DEFLATED 重写所有条目会装不上。最终改用 JDK 自带的 `jar uf`
   （实测原样保留各条目压缩方式，且不污染 META-INF）—— 构建因此只依赖 JDK。
3. **importmap 是「最长前缀优先」**：写检查器时按字典序匹配，得到 4 个假 404。
   用一个有 bug 的工具下结论比没工具更危险。
4. **别把编译错误 grep 掉**：曾把 javac 的报错过滤掉，最终表现为「d8 没产出 dex」，
   白折腾一轮。改完必须用真实环境跑一遍，不能只做语法检查。
5. **SSH 到 Windows**：默认 shell 是 PowerShell（cmd 语法报错）、二进制 stdin 会损坏
   （用 scp 传文件）、stdout 编码不可靠（**让远端写文件再 scp 取回**最稳）。
   另外 `Start-Process` 起的进程会随 SSH 会话被带走 —— 要脱离会话就用计划任务。
