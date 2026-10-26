import os
import zipfile

# 在项目根目录生成 GP-Next 可导入的 ZIP（pack.json 必须在根目录）。
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(root)
src = 'pvz-ai-agent-mod'
out = 'pvz-ai-agent.zip'
items = [
    ('pack.json', 'pack.json'),
    ('thumbnail.png', 'thumbnail.png'),
    ('README.md', 'README.md'),
    ('scripts/main.js', 'scripts/main.js'),
]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, arc in items:
        z.write(os.path.join(src, name), arc)
with zipfile.ZipFile(out) as z:
    for info in z.infolist():
        print(f'{info.filename:18} {info.file_size:8} -> {info.compress_size:8}')
print('zip bytes', os.path.getsize(out))
