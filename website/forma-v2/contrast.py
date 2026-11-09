#!/usr/bin/env python3
"""Forma v2 — WCAG 2.x contrast check for every palette in palettes.json.
Text pairs need >= 4.5, non-text marks (accent fill, ring, focus) >= 3.0.
Alpha colours (rgba) are composited over the pair's background first. Exit 1 on any failure."""
import json, re, sys, pathlib
def parse(c):
    c=c.strip()
    m=re.match(r'rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)',c)
    if m: return tuple(int(m.group(i)) for i in (1,2,3))+(float(m.group(4)),)
    c=c.lstrip('#'); return (int(c[0:2],16),int(c[2:4],16),int(c[4:6],16),1.0)
def over(fg,bg):
    a=fg[3]; return tuple(round(fg[i]*a+bg[i]*(1-a)) for i in range(3))+(1.0,)
def lum(c):
    def ch(v):
        v/=255; return v/12.92 if v<=0.03928 else ((v+0.055)/1.055)**2.4
    r,g,b=(ch(x) for x in c[:3]); return 0.2126*r+0.7152*g+0.0722*b
def ratio(fg,bg):
    bg=parse(bg) if isinstance(bg,str) else bg
    fg=over(parse(fg),bg)
    a,b=sorted((lum(fg),lum(bg)),reverse=True); return (a+0.05)/(b+0.05)
TEXT=[('ink','bg'),('ink','surface'),('ink2','bg'),('ink2','surface'),('t2','bg'),('t3','bg'),('t3','surface'),
      ('accentText','bg'),('accentText','surface'),('onAccent','accent')]
MARK=[('accent','bg'),('focus','bg')]
data=json.loads(pathlib.Path(__file__).with_name('palettes.json').read_text())
fail=0; out=[]
for name,themes in data.items():
    for theme,p in themes.items():
        p=dict(p); p.setdefault('focus',p.get('accentText'))
        for kind,pairs,minv in (('testo',TEXT,4.5),('segno',MARK,3.0)):
            for f,b in pairs:
                if f not in p or b not in p: continue
                r=ratio(p[f],p[b]); ok=r>=minv; fail+= (not ok)
                out.append(f"| {name} | {theme} | {f} {p[f]} su {b} {p[b]} | {kind} | {r:.2f} | {'OK' if ok else 'FAIL'} |")
        for f,b in p.get('extra',[]):
            fv=p.get(f,f); bv=p.get(b,b); r=ratio(fv,bv); ok=r>=3.0; fail+=(not ok)
            out.append(f"| {name} | {theme} | {f} {fv} su {b} {bv} | segno | {r:.2f} | {'OK' if ok else 'FAIL'} |")
print("| progetto | tema | coppia | tipo | rapporto | esito |\n|---|---|---|---|---|---|"); print("\n".join(out))
print(f"\nFAIL: {fail}", file=sys.stderr); sys.exit(1 if fail else 0)
