#!/usr/bin/env python3
"""Build the public site (index.html at the repo root) from src/game.html + src/net-adapter.js.

  python3 src/build.py            # build and minify (uses esbuild via npx when available)
  python3 src/build.py --no-min   # build without minifying

src/game.html is the whole game. It also runs on its own as the claude.ai artifact version
(online play there uses the claude.ai "room" capability). For the public site this script
adds Supabase (Realtime + WebRTC through net-adapter.js) in front of three.js.

Only the Supabase *publishable* key belongs here: it is public by design (it ships in the page).
Never put the secret / service_role key in this repo.
"""
import json, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SUPA_URL = 'https://bkzwwisnvaqefsinvcyg.supabase.co'
SUPA_KEY = 'sb_publishable_t4bDfZSkT-511aGxVh3H0Q_SYJnNZHH'   # publishable (public) key

src = open(os.path.join(HERE, 'game.html'), encoding='utf-8').read()
adapter = open(os.path.join(HERE, 'net-adapter.js'), encoding='utf-8').read()
head = '''<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>
'''
cfg = ('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.113.0/dist/umd/supabase.js"></script>\n'
       '<script>window.BT_SUPA = ' + json.dumps({'url': SUPA_URL, 'key': SUPA_KEY}) + ';</script>\n<script>\n' + adapter + '\n</script>\n')
tag = '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>'
assert src.count(tag) == 1, 'three.js script tag not found in game.html'
out = head + src.replace(tag, cfg + tag) + '\n</body></html>\n'

def esbuild(code, loader):
    exe = shutil.which('esbuild')
    cmd = [exe] if exe else (['npx', '--yes', 'esbuild'] if shutil.which('npx') else None)
    if not cmd:
        return None
    try:
        # --charset=utf8: keep Japanese text as it is (the default writes every character as \uXXXX, which makes the page much bigger)
        r = subprocess.run(cmd + ['--minify', '--charset=utf8', '--loader=' + loader] + (['--target=es2019'] if loader == 'js' else []),
                           input=code.encode(), capture_output=True, timeout=120)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if r.returncode != 0:
        if code == 'let a=1':
            return None

        sys.exit('esbuild failed: ' + r.stderr.decode()[:500])
    return r.stdout.decode().strip()

if '--no-min' not in sys.argv and esbuild('let a=1', 'js') is not None:
    out = re.sub(r'<script>(.*?)</script>', lambda m: '<script>' + esbuild(m.group(1), 'js') + '</script>', out, flags=re.S)
    out = re.sub(r'<style>(.*?)</style>', lambda m: '<style>' + esbuild(m.group(1), 'css') + '</style>', out, flags=re.S)
    # squeeze the space between HTML tags, but never inside a script (text in the code must stay as written)
    parts = re.split(r'(<script\b.*?</script>)', out, flags=re.S)
    out = ''.join(x if x.startswith('<script') else re.sub(r'>\s*\n\s*<', '><', x) for x in parts)
    print('minified')
else:
    print('not minified (esbuild not found, or --no-min)')

open(os.path.join(ROOT, 'index.html'), 'w', encoding='utf-8').write(out)
print('wrote index.html', len(out.encode()), 'bytes')
