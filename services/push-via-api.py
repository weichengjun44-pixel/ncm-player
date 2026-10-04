#!/usr/bin/env python3
# 走 GitHub REST API 推送：当 github.com:443 被墙/抖动但 api.github.com 可用时使用。
# 等价于 git push —— 同样生成 blob / tree / commit 并更新 ref。
import base64, json, subprocess, sys, pathlib

REPO = "weichengjun44-pixel/ncm-player"
BRANCH = "main"
ROOT = pathlib.Path(r"D:\code\ncm-player")
GH = r"D:\Apps\gh\bin\gh.exe"

def gh(*args, input_json=None):
    cmd = [GH, "api"] + list(args)
    if input_json is not None:
        cmd += ["--input", "-"]
    p = subprocess.run(cmd, input=json.dumps(input_json).encode() if input_json is not None else None,
                       capture_output=True)
    if p.returncode != 0:
        print("✗ gh 失败:", " ".join(args)); print(p.stderr.decode(errors="replace")); sys.exit(1)
    out = p.stdout.decode().strip()
    return json.loads(out) if out else None

# 推送全部跟踪文件（不用 base_tree：本地可能缺少远端 API 提交的对象，diff 会算空 → 422）
parent_sha = gh(f"repos/{REPO}/git/ref/heads/{BRANCH}")["object"]["sha"]
msg = subprocess.run(["git", "-C", str(ROOT), "log", "-1", "--pretty=%B", "HEAD"],
                     capture_output=True).stdout.decode().strip()
diff = [f for f in subprocess.run(["git", "-C", str(ROOT), "ls-files"],
                                  capture_output=True).stdout.decode().split() if f.strip()]
print("父提交:", parent_sha[:7], "· 文件", len(diff), "个")
print("说明  :", msg.splitlines()[0])

tree = []
for f in diff:
    data = (ROOT / f).read_bytes()
    blob = gh(f"repos/{REPO}/git/blobs", input_json={
        "content": base64.b64encode(data).decode(), "encoding": "base64"})["sha"]
    tree.append({"path": f.replace("\\", "/"), "mode": "100644", "type": "blob", "sha": blob})

new_tree = gh(f"repos/{REPO}/git/trees", input_json={"tree": tree})["sha"]
print("新 tree:", new_tree[:8])

# 提交者信息沿用本地 git 配置
name = subprocess.run(["git", "-C", str(ROOT), "config", "user.name"], capture_output=True).stdout.decode().strip()
email = subprocess.run(["git", "-C", str(ROOT), "config", "user.email"], capture_output=True).stdout.decode().strip()
commit = gh(f"repos/{REPO}/git/commits", input_json={
    "message": msg, "tree": new_tree, "parents": [parent_sha],
    "author": {"name": name, "email": email},
    "committer": {"name": name, "email": email}})["sha"]
print("新 commit:", commit[:8])

res = gh(f"repos/{REPO}/git/refs/heads/{BRANCH}", "-X", "PATCH",
         input_json={"sha": commit, "force": False})
print("✓ ref 已更新 →", res["object"]["sha"][:8])
