"""Embed the offline workbench in the app, allowing only its own page script."""
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
page = (root / 'MacApp/WorkbenchPage.template').read_text()
example = (root / '示例/发送失败的爱·第一版.md').read_text()
example_json = json.dumps(example, ensure_ascii=False).replace('<', r'\u003c')
page = page.replace('__WORKBENCH_EXAMPLE_JSON__', example_json, 1)
script = re.search(r'<script>(.*?)</script>', page, re.S).group(1)
subprocess.run(['node', '--check'], input=script, text=True, check=True)
for name in ('剧本编辑.js', '选择菜单.js', '分镜预览.js'):
    subprocess.run(['node', '--check', str(root / '工作台资源' / name)], check=True)
for asset in re.findall(r'(?:src|href)="(工作台资源/[^"]+)"', page):
    if not (root / asset).is_file():
        raise FileNotFoundError(asset)
digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
policy = (f"default-src 'none'; script-src 'self' file: 'sha256-{digest}'; "
          "style-src 'self' file: 'unsafe-inline'; img-src 'self' data: blob: storyboard-image:; "
          "font-src 'self' data:; form-action 'none'; base-uri 'none'")
head, tag, tail = page.partition('<head>')
if not tag:
    raise ValueError('缺少页面头部')
Path(sys.argv[1]).write_text(head + tag + '<meta http-equiv="Content-Security-Policy" content="' + policy + '">' + tail)
