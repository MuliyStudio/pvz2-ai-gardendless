#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打完整发布包：模组 ZIP + 启动器 + MCP Server + 配置脚本。

产物：
  dist/PvZAI-LLM-Agent-Bundle/            解压即用的目录
  dist/PvZAI-LLM-Agent-Bundle-v<版本>.zip  发给玩家的压缩包

用法：
  python tools/build_bundle.py              # 全量（重新构建模组 + 重新编译启动器）
  python tools/build_bundle.py --skip-mod   # 复用现有 pvz-llm-agent.zip
  python tools/build_bundle.py --skip-exe   # 不重新编译启动器
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT = ROOT / "pvz-llm-agent"
BASE = ROOT / "tools" / "bundle"
DIST = ROOT / "dist"
OUT = DIST / "PvZAI-LLM-Agent-Bundle"

# 启动器源码与编译参数（.NET Framework 4.8，随 Windows 自带，玩家不用装 .NET）
CSC_CANDIDATES = [
    Path(os.environ.get("WINDIR", r"C:\Windows")) / "Microsoft.NET" / "Framework64" / "v4.0.30319" / "csc.exe",
    Path(os.environ.get("WINDIR", r"C:\Windows")) / "Microsoft.NET" / "Framework" / "v4.0.30319" / "csc.exe",
]
CSC_REFS = ["System.dll", "System.Core.dll", "System.Windows.Forms.dll",
            "System.Web.Extensions.dll", "System.IO.Compression.dll",
            "System.IO.Compression.FileSystem.dll"]

# MCP Server 与它依赖的工具模块（server.mjs -> ../tools/*.js）
MCP_FILES = ["mcp/server.mjs", "mcp/cdp.js", "mcp/protocol.js"]
TOOL_FILES = ["tools/definitions.js", "tools/errors.js", "tools/router.js",
              "tools/wait.js", "tools/format.js"]

args = set(sys.argv[1:])

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def log(msg):
    print(msg)


def read_pack():
    pack = json.loads((AGENT / "pack" / "pack.json").read_text(encoding="utf-8"))
    return pack["version"], pack["uuid"], pack["name"]


def build_mod():
    log("[1/4] 构建模组 ZIP ...")
    subprocess.run([os.environ.get("NODE", "node"), "scripts/build-pack.mjs"],
                   cwd=AGENT, check=True)
    zip_path = AGENT / "pvz-llm-agent.zip"
    if not zip_path.exists():
        raise SystemExit("构建后仍没有 pvz-llm-agent.zip")
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
    if "pack.json" not in names:
        raise SystemExit("模组 ZIP 根目录缺少 pack.json：%s" % names)
    log("      -> pvz-llm-agent.zip (%d 字节, %s)" % (zip_path.stat().st_size, ", ".join(names)))


def build_launcher(target):
    if "--skip-exe" in args:
        if target.exists():
            log("      复用已编译的启动器：%s" % target)
            return
        old = ROOT / "PvZAI-发布包" / "PvZAI_Launcher.exe"
        if old.exists():
            shutil.copy2(old, target)
            log("      复用旧启动器：%s" % old)
            return
        raise SystemExit("--skip-exe 但找不到可复用的 PvZAI_Launcher.exe")

    csc = next((p for p in CSC_CANDIDATES if p.exists()), None)
    if csc is None:
        raise SystemExit("找不到 csc.exe（.NET Framework 4.8 编译器），无法编译启动器")

    log("[2/4] 编译启动器 ...")
    # csc 是原生程序，对非 ASCII 路径的临时资源文件不友好：在 ASCII 临时目录里编译，再挪回来。
    work = Path(tempfile.mkdtemp(prefix="pvzlauncher-"))
    try:
        src = work / "PvZAI_Launcher.cs"
        shutil.copy2(ROOT / "tools" / "PvZAI_Launcher.cs", src)
        out_exe = work / "PvZAI_Launcher.exe"
        cmd = [str(csc), "/nologo", "/target:exe", "/platform:anycpu", "/optimize+",
               "/codepage:65001", "/out:" + str(out_exe),
               *["/r:" + r for r in CSC_REFS],
               str(src)]
        subprocess.run(cmd, check=True, cwd=str(work))
        shutil.copy2(out_exe, target)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    log("      -> PvZAI_Launcher.exe (%d 字节)" % target.stat().st_size)


def to_crlf(path):
    """bat/txt 用 CRLF：cmd 对纯 LF 的 goto 分支处理不稳，记事本也更好看。"""
    data = Path(path).read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    Path(path).write_bytes(data)


def clean_out():
    """清空上一次的产物目录。目录里的 exe 可能正被玩家运行（文件被锁），跳过它继续。"""
    if not OUT.exists():
        return
    try:
        shutil.rmtree(OUT)
        return
    except PermissionError:
        pass
    for path in sorted(OUT.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        try:
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()
        except OSError:
            log("      ! 跳过被占用的文件：%s" % path.name)


def assemble(version, uuid, name):
    log("[3/4] 组装发布包目录 ...")
    clean_out()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "mcp").mkdir(exist_ok=True)
    (OUT / "tools").mkdir(exist_ok=True)

    shutil.copy2(AGENT / "pvz-llm-agent.zip", OUT / "pvz-llm-agent.zip")
    for rel in MCP_FILES:
        shutil.copy2(AGENT / rel, OUT / rel)
    for rel in TOOL_FILES:
        shutil.copy2(AGENT / rel, OUT / rel)
    shutil.copy2(ROOT / "tools" / "install_mcp_config.mjs", OUT / "tools" / "install_mcp_config.mjs")
    staged_exe = DIST / "PvZAI_Launcher.exe"
    target_exe = OUT / "PvZAI_Launcher.exe"
    if staged_exe.exists():
        try:
            shutil.copy2(staged_exe, target_exe)
        except PermissionError:
            if target_exe.exists():
                log("      ! 目录里的启动器正在运行，保留原 exe（内容一致）")
            else:
                raise SystemExit("启动器写不进去，请先关掉正在运行的 PvZAI_Launcher.exe")
    if not target_exe.exists():
        raise SystemExit("发布包里缺 PvZAI_Launcher.exe，先跑一次完整构建")

    # 玩家文档 / 配置入口
    shutil.copy2(BASE / "安装说明.txt", OUT / "安装说明.txt")
    shutil.copy2(BASE / "配置MCP.bat", OUT / "配置MCP.bat")
    to_crlf(OUT / "安装说明.txt")
    to_crlf(OUT / "配置MCP.bat")
    contract = AGENT / "docs" / "tool-contract.md"
    if contract.exists():
        shutil.copy2(contract, OUT / "MCP工具契约.md")
    # 完整说明沿用仓库根 README（和上一版发布包一样：README + 安装说明 + 工具契约）
    shutil.copy2(ROOT / "README.md", OUT / "README.md")

    # Node 需要 type=module 才会把 tools/*.js 当 ES module 解析
    (OUT / "package.json").write_text(json.dumps({
        "name": "pvz-llm-agent-bundle",
        "version": version,
        "private": True,
        "type": "module",
        "description": "PvZ2 Gardendless MCP Server 运行时（%s · %s）" % (name, uuid),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    log("      -> %s" % OUT.relative_to(ROOT))


def make_zip(version):
    log("[4/4] 打包 ZIP ...")
    out = DIST / ("PvZAI-LLM-Agent-Bundle-v%s.zip" % version)
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in sorted(OUT.rglob("*")):
            if path.is_file():
                z.write(path, path.relative_to(DIST).as_posix())
    with zipfile.ZipFile(out) as z:
        for info in z.infolist():
            log("      %-42s %8d -> %8d" % (info.filename, info.file_size, info.compress_size))
    log("")
    log("完成：%s (%d 字节)" % (out.relative_to(ROOT), out.stat().st_size))
    log("目录：%s" % OUT.relative_to(ROOT))
    return out


def main():
    DIST.mkdir(parents=True, exist_ok=True)
    version, uuid, name = read_pack()
    log("PvZ LLM Agent 发布包 · v%s (%s)" % (version, uuid))
    if "--skip-mod" not in args:
        build_mod()
    elif not (AGENT / "pvz-llm-agent.zip").exists():
        raise SystemExit("--skip-mod 但没有 pvz-llm-agent.zip，先跑一次完整构建")

    exe = DIST / "PvZAI_Launcher.exe"
    build_launcher(exe)
    assemble(version, uuid, name)
    make_zip(version)


if __name__ == "__main__":
    main()
