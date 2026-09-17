"""Render the silent 20s hero illustration. Offline tool; not part of deployment.
Requires Pillow and ffmpeg. Run from repository root.
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import subprocess
W,H,FPS=1280,720,24
OUT=Path('public/media');OUT.mkdir(exist_ok=True)
BG='#1e2a30';PAPER='#fffdf5';GOLD='#d6b365';MUTED='#b8c4c8'
def font(n,bold=False):
 return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans'+('-Bold' if bold else '')+'.ttf',n)
def frame(t):
 im=Image.new('RGB',(W,H),BG);d=ImageDraw.Draw(im)
 def txt(x,y,s,n=24,c=PAPER,b=False):d.text((x,y),s,font=font(n,b),fill=c)
 txt(64,44,'M U R I K A H',24,GOLD,True)
 txt(64,100,'From evidence to action.',48,PAPER,True)
 txt(64,168,'INTERNAL AUDIT  /  GOVERNANCE  /  SOFTWARE',18,MUTED)
 if t<16:
  stage=min(3,int(t/4)); labels=['Evidence','Review','Ownership','Follow-up']
  for i,label in enumerate(labels):
   x=64+i*294
   d.line((x,242,x+265,242),fill=GOLD if i<=stage else '#536068',width=3)
   txt(x,264,f'0{i+1}  {label}',22,GOLD if i==stage else MUTED)
  d.rounded_rectangle((64,326,1216,616),radius=14,fill=PAPER)
  txt(100,357,'ACCESS REVIEW',16,'#766031',True)
  txt(100,392,'Make every approval traceable.',32,BG,True)
  lines=[('Evidence recorded','Two sampled reviews lack documented approval.'),('Finding reviewed','Check the evidence, scope and risk together.'),('Owner assigned','System owner records approval and resolves exceptions.'),('Closure checked','Validate the action and retain the supporting evidence.')]
  label,body=lines[stage]
  txt(100,460,label,25,BG,True);txt(100,507,body,23,'#44525b')
  # A subtle progress line supports the story without replacing readable text.
  d.rectangle((100,565,1180,569),fill='#e5e0d4');d.rectangle((100,565,100+1080*min(1,(t%4)/1.2),569),fill='#9a782e')
  txt(64,651,'ILLUSTRATIVE WORKFLOW · FICTIONAL EXAMPLE',16,MUTED)
 else:
  txt(64,265,'Choose your workspace.',40,PAPER,True)
  for i,(name,desc) in enumerate([('CMS','Customers & orders'),('GRC','Audit & risk'),('Tutor','Learning & research'),('ENGR','Maintenance & work orders')]):
   x=64+(i%2)*590;y=350+(i//2)*115
   d.line((x,y,x+540,y),fill='#536068',width=1)
   txt(x,y+16,name,29,GOLD,True);txt(x,y+60,desc,21,MUTED)
  txt(64,651,'murikah.com/products',21,PAPER)
 return im
poster=frame(1.5);poster.save(OUT/'murikah-hero.jpg',quality=88)
p=subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-crf','23','-preset','medium','-pix_fmt','yuv420p','-movflags','+faststart',str(OUT/'murikah-hero.mp4')],stdin=subprocess.PIPE)
for i in range(FPS*20):p.stdin.write((poster if i==0 else frame(i/FPS)).tobytes())
p.stdin.close()
if p.wait():raise SystemExit('ffmpeg render failed')
