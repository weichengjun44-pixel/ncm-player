; 自定义 NSIS 片段：把"默认安装目录"从 C 盘改到 D 盘。
;
; 为什么需要：electron-builder 在 perMachine:false 时默认装到
;   %LOCALAPPDATA%\Programs\<app>（即 C:\Users\<user>\AppData\Local\Programs\...）
; 用户明确要求"C 盘不留东西"。虽然安装向导允许手动改目录，
; 但默认值落在 C 盘、顺手点下一步就装到 C 盘了 —— 默认值必须纠正。
;
; 原理：安装向导的目录页读的是注册表里的 InstallLocation，
; 所以在 preInit 阶段先把它写成 D 盘的路径。

!macro preInit
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\NEBULA"
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\NEBULA"
!macroend
