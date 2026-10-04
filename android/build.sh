#!/usr/bin/env bash
# 手工构建 APK —— 刻意不用 Gradle
#
# 为什么不用 Gradle：Gradle 本体 + 它的依赖 + Android 的 maven 包在国内网络下拉起来非常痛苦
# （gradle 发行包、google()/mavenCentral() 仓库都可能龟速或超时）。
# 而 APK 的构建其实就是五步，SDK 的 build-tools 里全都有：
#   aapt2 编译资源 → aapt2 链接出 base.apk → javac 编 Java → d8 转 dex → zip 装进 apk
# 再 zipalign + apksigner 签名，就完事了。这个脚本把这条路走通，全程零网络依赖。
set -e

SDK="${SDK:-/d/Apps/android-sdk}"
# JDK 路径自动探测（不写死版本号，升级 JDK 后不用改脚本）
if [ -z "$JDK_HOME" ]; then
  JDK_HOME=$(find /d/Apps/jdk17 -maxdepth 4 -name "javac.exe" 2>/dev/null | head -1 | xargs -r dirname | xargs -r dirname)
fi
JDK_HOME="${JDK_HOME:-/d/Apps/jdk17}"
BT="$SDK/build-tools/34.0.0"
AJAR="$SDK/platforms/android-34/android.jar"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/build"
APPNAME="NEBULA"

export PATH="$JDK_HOME/bin:$BT:$PATH"

# Windows 原生程序不认 MSYS 路径，转成原生写法
win() { echo "$1" | sed -e 's|^/\([a-z]\)/|\1:/|' ; }
SDK_W=$(win "$SDK"); BT_W=$(win "$BT"); AJAR_W=$(win "$AJAR"); HERE_W=$(win "$HERE"); OUT_W=$(win "$OUT")

for f in "$BT/aapt2.exe" "$AJAR" "$JDK_HOME/bin/javac.exe"; do
  [ -e "$f" ] || { echo "✗ 缺少 $f"; exit 1; }
done

echo "=== 0) 准备输出目录 ==="
rm -rf "$OUT"; mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"
echo "  $OUT"

echo "=== 1) aapt2 编译资源 ==="
"$BT/aapt2.exe" compile --dir "$HERE_W/res" -o "$OUT_W/res.zip"
echo "  ✓ res.zip"

echo "=== 2) aapt2 链接出 base.apk ==="
"$BT/aapt2.exe" link \
  -o "$OUT_W/base.apk" \
  -I "$AJAR_W" \
  --manifest "$HERE_W/AndroidManifest.xml" \
  -R "$OUT_W/res.zip" \
  --java "$OUT_W/gen" \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code 1 --version-name 0.1 \
  --no-version-vectors
echo "  ✓ base.apk（含清单与资源）"

echo "=== 3) javac 编译 Java ==="
# javac 是 Windows 原生程序，读不了 MSYS 的 /d/... 路径 —— 源文件列表必须用 Windows 写法
# （之前混用导致编译失败，而且我还用 grep 把错误输出吞了，白折腾一轮）
find "$(pwd -W)/build/gen" -name '*.java' > "$OUT/sources.txt"
echo "$HERE_W/src/cn/nebula/player/MainActivity.java" >> "$OUT/sources.txt"
"$JDK_HOME/bin/javac.exe" -encoding UTF-8 -source 8 -target 8 -nowarn \
  -bootclasspath "$AJAR_W" -cp "$AJAR_W" \
  -d "$OUT_W/classes" @"$OUT_W/sources.txt"
echo "  ✓ classes: $(find "$OUT/classes" -name '*.class' | wc -l) 个"

echo "=== 4) d8 转成 dex ==="
CLASSES=$(find "$(pwd -W)/build/classes" -name '*.class')
"$BT/d8.bat" --release --lib "$AJAR_W" --min-api 24 --output "$OUT_W/dex" $CLASSES
echo "  ✓ $(ls "$OUT/dex" 2>/dev/null || echo '（没产出 dex）')"

echo "=== 5) classes.dex 装进 APK（用 JDK 自带的 jar，不依赖 python）==="
# 为什么用 jar 而不是 python/zip：
#  - python 在服务器上不在 PATH（构建会断在最后一步）
#  - zip 在 Git-for-Windows 里也没有
#  - jar 是 JDK 自带，两边都有；实测它【原样保留既有条目的压缩方式】——
#    resources.arsc 必须保持 STORED（API 30+ 硬要求），这点已验证
cp "$OUT/base.apk" "$OUT/unsigned.apk"
cp "$OUT/dex/classes.dex" "$OUT/classes.dex"
( cd "$OUT" && "$JDK_HOME/bin/jar.exe" uf "$OUT_W/unsigned.apk" classes.dex )
rm -f "$OUT/classes.dex"
echo "  ✓ classes.dex 已写入"

echo "=== 6) 签名密钥（首次自动生成）==="
KS="$HERE/nebula.keystore"
if [ ! -f "$KS" ]; then
  "$JDK_HOME/bin/keytool.exe" -genkeypair -keystore "$(win "$KS")" -alias nebula \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass nebula-local-key -keypass nebula-local-key \
    -dname "CN=NEBULA, OU=Personal, O=Personal, L=CN" 2>&1 | tail -1
  echo "  ✓ 已生成 $KS（这是本地自签名用的密钥，不是你的账号密码）"
else
  echo "  · 复用已有密钥"
fi

echo "=== 7) zipalign ==="
"$BT/zipalign.exe" -f 4 "$OUT_W/unsigned.apk" "$OUT_W/aligned.apk"
echo "  ✓ aligned.apk"

echo "=== 8) apksigner 签名 ==="
"$BT/apksigner.bat" sign --ks "$(win "$KS")" --ks-key-alias nebula \
  --ks-pass pass:nebula-local-key --key-pass pass:nebula-local-key \
  --out "$OUT_W/$APPNAME.apk" "$OUT_W/aligned.apk"
echo "  ✓ 签名完成"

echo "=== 9) 验证 ==="
"$BT/apksigner.bat" verify --print-certs "$OUT_W/$APPNAME.apk" 2>&1 | head -4
"$BT/aapt2.exe" dump badging "$OUT_W/$APPNAME.apk" 2>/dev/null | head -4
ls -la "$OUT/$APPNAME.apk" | awk '{printf "\n  ▶ %s  %.2f MB\n", $NF, $5/1048576}'
