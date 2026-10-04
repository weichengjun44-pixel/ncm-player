#!/usr/bin/env bash
# 解压 JDK 与 Android SDK，并装上构建需要的两个包（platform + build-tools）
# 全部来自 dl.google.com（实测本机直连可达），装到 D 盘
set -e
cd /d/Apps

echo "=== 1) 解压 JDK 17 ==="
JDKEXIST=$(find /d/Apps/jdk17 -maxdepth 4 -name "javac.exe" 2>/dev/null | head -1)
if [ -n "$JDKEXIST" ]; then
  echo "  · JDK 已解压，跳过"
  JDKDIR=$(dirname "$(dirname "$JDKEXIST")")
elif [ -f jdk17.zip ]; then
  # Windows 自带 bsdtar 能解 zip；MSYS 的 unzip 作为备选
  "C:/Windows/System32/tar.exe" -xf jdk17.zip -C jdk17 2>/dev/null || unzip -q -o jdk17.zip -d jdk17
  JDKDIR=$(find jdk17 -maxdepth 4 -name "javac.exe" | head -1 | xargs -r dirname | xargs -r dirname)
  [ -n "$JDKEXIST" ] || echo "  ✓ JDK: $JDKDIR"
  "$JDKDIR/bin/java.exe" -version 2>&1 | head -2 | sed 's/^/    /'
else
  echo "  ✗ 没有 jdk17.zip"; exit 1
fi

echo "=== 2) 解压 cmdline-tools ==="
if [ -f cmdline-tools.zip ]; then
  rm -rf android-sdk/_tmp
  mkdir -p android-sdk/_tmp
  "C:/Windows/System32/tar.exe" -xf cmdline-tools.zip -C android-sdk/_tmp 2>/dev/null || unzip -q -o cmdline-tools.zip -d android-sdk/_tmp
  rm -rf android-sdk/cmdline-tools
  mkdir -p android-sdk/cmdline-tools
  mv android-sdk/_tmp/cmdline-tools android-sdk/cmdline-tools/latest
  rm -rf android-sdk/_tmp
  ls android-sdk/cmdline-tools/latest/bin/ | head -5 | sed 's/^/    /'
else
  echo "  ✗ 没有 cmdline-tools.zip"; exit 1
fi

echo "=== 3) 用 sdkmanager 装 platform-34 与 build-tools-34 ==="
SDKM="D:/Apps/android-sdk/cmdline-tools/latest/bin/sdkmanager.bat"
JDKW=$(cd "$JDKDIR" && pwd -W 2>/dev/null || echo "$JDKDIR")
export JAVA_HOME="$JDKW"
# sdkmanager.bat 内部调用 java，必须让 java 在 PATH 里（否则报 java not found 却看不出原因）
export PATH="$JDKW/bin:$PATH"
echo "  java: $(java -version 2>&1 | head -1)"
echo "  JAVA_HOME=$JAVA_HOME"
# 先接受许可，再安装
yes 2>/dev/null | "$SDKM" --sdk_root=D:/Apps/android-sdk --licenses >/tmp/sdk-lic.log 2>&1 || true
tail -3 /tmp/sdk-lic.log | sed 's/^/    /'
"$SDKM" --sdk_root=D:/Apps/android-sdk "platforms;android-34" "build-tools;34.0.0" 2>&1 | tail -6 | sed 's/^/    /'

echo "=== 4) 核对 ==="
ls -la /d/Apps/android-sdk/platforms/android-34/android.jar 2>/dev/null | awk '{printf "  ✓ android.jar %.0f MB\n", $5/1048576}' || echo "  ✗ android.jar 缺失"
for T in aapt2 zipalign apksigner; do
  ls /d/Apps/android-sdk/build-tools/34.0.0/$T* >/dev/null 2>&1 && echo "  ✓ $T" || echo "  ✗ $T 缺失"
done
echo "SETUP-DONE"
