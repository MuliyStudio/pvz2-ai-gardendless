import os
import subprocess
import sys
import zipfile

# 在项目根目录生成 GP-Next 可导入的 ZIP（pack.json 必须在根目录）。
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(root)

# 打包前必须用“函数体上下文”校验入口（GP-Next 会把 export default 换成 return 再当函数体执行）。
# 只用 `node --check` 会按 ESM 解析，放过“注释把下一行代码吃掉”之类的错误。
check = subprocess.run(['node', os.path.join('tools', 'check_mod.js')], capture_output=True, text=True, encoding='utf-8', errors='replace')
print(check.stdout.strip() or check.stderr.strip())
if check.returncode != 0:
    print('打包中止：入口语法校验失败（见上）', file=sys.stderr)
    sys.exit(1)

# MCP Server 也要校验：指南文本是模板字符串，写错反引号会直接把 server 打死。
srv = subprocess.run(['node', '--check', os.path.join('PvZ-MCP', 'pvz-mcp-server.mjs')], capture_output=True, text=True, encoding='utf-8', errors='replace')
print('[check_server] ' + ('OK' if srv.returncode == 0 else 'FAILED'))
if srv.returncode != 0:
    print(srv.stderr.strip()[:800], file=sys.stderr)
    sys.exit(1)

src = 'pvz-ai-agent-mod'
out = 'pvz-ai-agent.zip'
items = [
    ('pack.json', 'pack.json'),
    ('thumbnail.png', 'thumbnail.png'),
    ('README.md', 'README.md'),
    ('strategy.md', 'strategy.md'),
    ('scripts/main.js', 'scripts/main.js'),
]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, arc in items:
        z.write(os.path.join(src, name), arc)
with zipfile.ZipFile(out) as z:
    for info in z.infolist():
        print(f'{info.filename:18} {info.file_size:8} -> {info.compress_size:8}')
print('zip bytes', os.path.getsize(out))
