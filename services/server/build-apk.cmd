@echo off
rem 在服务器上构建 APK（用 Git 自带的 bash 跑 android/build.sh）
rem 通过计划任务调用，输出写日志文件（SSH 的 stdout 编码不可靠）
set LOG=D:\nebula\logs\apkbuild.log
echo ==== build start %DATE% %TIME% ==== > "%LOG%"
"C:\Program Files\Git\bin\bash.exe" -lc "cd /d/nebula/android && chmod +x build.sh && bash build.sh" >> "%LOG%" 2>&1
echo ==== build exit %ERRORLEVEL% ==== >> "%LOG%"
