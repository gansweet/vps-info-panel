#!/usr/bin/env python3
"""把 src/ui.html、scripts/install.sh、agent/agent.sh 内嵌进 worker.js（标记 @@EMBED-START/END 之间）。修改这三个源文件后运行：python3 scripts/embed.py"""
import json, os, re
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rd = lambda p: open(os.path.join(root, p), encoding='utf-8').read()
block = "// @@EMBED-START\nconst HTML = %s;\nconst INSTALL_SH = %s;\nconst AGENT_SH = %s;\n// @@EMBED-END" % tuple(json.dumps(rd(p), ensure_ascii=False) for p in ('src/ui.html', 'scripts/install.sh', 'agent/agent.sh'))
s = rd('worker.js'); n = re.sub(r'// @@EMBED-START.*?// @@EMBED-END', lambda m: block, s, flags=re.S)
assert n != s or '@@EMBED-START' in s, 'markers not found'
open(os.path.join(root, 'worker.js'), 'w', encoding='utf-8').write(n); print('embedded', len(n), 'bytes')
