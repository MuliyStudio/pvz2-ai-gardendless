import zipfile, os
root = 'PvZAI-发布包'
out = 'PvZAI-AI草坪指挥官-发布包.zip'
if os.path.exists(out): os.remove(out)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for d, _, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            arc = os.path.relpath(p, '.')
            z.write(p, arc)
with zipfile.ZipFile(out) as z:
    for i in z.infolist():
        print(f'{i.filename:50} {i.file_size:8} -> {i.compress_size:8}')
print('zip bytes', os.path.getsize(out))
