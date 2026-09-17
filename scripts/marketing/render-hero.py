"""Source-grounded UI demonstration with fictional records; not a screen recording.
Offline only: python scripts/marketing/render-hero.py (Pillow + ffmpeg).
See docs/marketing/hero-storyboard.md for source mappings and timing.
"""
from functools import lru_cache
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw, ImageFont

W, H, FPS, SECONDS = 1280, 900, 24, 60
OUT = Path('public/media')
BG, NAVY, GOLD = '#1e2a30', '#0b1733', '#d6b365'
PAPER, WHITE, INK, MUTED, LINE = '#f8f4ea', '#fffcf6', '#172534', '#647080', '#dfdfdc'

@lru_cache(None)
def font(size, bold=False):
    return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans' + ('-Bold' if bold else '') + '.ttf', size)

def ease(value):
    v = max(0, min(1, value))
    return v * v * (3 - 2 * v)

def typed(value, t, start, duration=2):
    return value[:int(len(value) * max(0, min(1, (t-start)/duration)))]

def frame(time):
    scene = min(3, int(time / 15))
    t = time - scene * 15
    product = ['Tutor', 'CMS', 'ENGR', 'GRC'][scene]
    titles = ['Turn a question into understanding.', 'Turn an enquiry into a lead.', 'Put the right technician on the job.', 'Give every action an owner.']
    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)
    def text(x, y, value, size=22, color=INK, bold=False):
        d.text((x, y), value, font=font(size, bold), fill=color)
    def box(x, y, w, h, fill=WHITE, outline=None, radius=12):
        d.rounded_rectangle((x, y, x+w, y+h), radius, fill=fill, outline=outline)
    def button(x, y, label, w=220):
        box(x, y, w, 48, NAVY)
        text(x+18, y+10, label, 20, WHITE, True)
    def field(x, y, label, value, w=720):
        text(x, y, label, 18, MUTED)
        box(x, y+29, w, 48, WHITE, LINE, 7)
        text(x+14, y+39, value, 21)
    def pill(x, y, label):
        box(x, y, int(d.textlength(label, font=font(17)))+28, 32, '#e7f1e9', radius=7)
        text(x+14, y+5, label, 17, '#285c40')
    text(40, 27, 'M U R I K A H', 19, GOLD, True)
    text(40, 65, titles[scene], 34, WHITE, True)
    # Product chapters stay visible; active chapter progresses continuously.
    for i, name in enumerate(['Tutor', 'CMS', 'ENGR', 'GRC']):
        x = 40+i*302
        text(x, 125, f'0{i+1}  {name}', 19, GOLD if i == scene else '#b8c4c8', i == scene)
        d.line((x, 158, x+276, 158), '#536068', 2)
        if i <= scene:
            d.line((x, 158, x+276*(min(1,t/15) if i==scene else 1), 158), GOLD, 3)
    # Enlarged, deliberately cropped product shell keeps interactions readable.
    box(40, 184, 1200, 603, WHITE, radius=12)
    box(40, 184, 210, 603, '#f1f2f2' if scene == 0 else NAVY, radius=12)
    navcolor = INK if scene == 0 else WHITE
    text(58, 212, 'Murikah | '+product, 20, navcolor, True)
    navs = [['Home','Co-Writer','Diagram Design','Book','Mastery Path'], ['Overview','Leads','Accounts','Orders','Service requests'], ['Overview','Requests','Work orders','Maintenance','Assets'], ['Dashboard','Work papers','Action plans','Evidence','Reports']][scene]
    active = [0,1,2,2][scene]
    for i, item in enumerate(navs):
        if i == active:
            box(50, 270+i*53, 190, 43, '#e4e6e6' if scene == 0 else '#263455', radius=7)
        text(64, 281+i*53, item, 18, navcolor)
    text(278, 205, product+'  /  '+navs[active], 17, MUTED)
    d.line((270, 245, 1218, 245), LINE, 1)
    cx, cy, click = 1140, 733, None
    if scene == 0:
        text(284, 273, 'Learn something new', 27, INK, True)
        prompt = 'Explain precision and recall with an example.'
        if t < 5:
            text(284, 332, 'Start with any learning goal.', 22, MUTED)
        else:
            box(370, 321, 822, 65, '#eeeeee')
            text(392, 341, prompt, 22)
            text(284, 416, 'Murikah Tutor', 19, '#957327', True)
            lines = ['Imagine a filter that flags 10 messages as spam.', 'Eight really are spam. Precision = 8 / 10 = 80%.', 'There are 20 spam messages in total.', 'Recall = 8 / 20 = 40%.', 'Precision: how often a flag is right.', 'Recall: how much spam the filter finds.']
            for i, line in enumerate(lines):
                text(284, 455+i*31, typed(line,t,5.7+i*.58,.65), 21)
        box(278, 682, 930, 78, WHITE, LINE)
        text(297, 702, typed(prompt,t,.8,2.6) if t < 5 else 'Ask a follow-up question…', 20, INK if t<5 else MUTED)
        button(1090, 697, 'Send', 101)
        cx,cy,click=1143,722,4.7
    elif scene == 1:
        text(284, 270, 'Leads', 28, INK, True)
        button(985, 268, 'Add lead', 205)
        text(284, 338, 'Title', 18, MUTED)
        text(720, 338, 'Source', 18, MUTED)
        text(980, 338, 'Owner', 18, MUTED)
        d.line((284,375,1192,375),LINE,1)
        if t >= 10.2:
            text(284, 398, 'Solar pump installation', 22, INK, True)
            text(720, 398, 'Website', 22)
            text(980, 398, 'Alex Kim', 22)
            pill(284, 466, 'Lead created')
            text(284, 531, 'An enquiry ready for your team to follow up.', 22, MUTED)
        elif t >= 1.5:
            x = int(1240-930*ease((t-1.5)/.6))
            box(x, 252, 909, 515, PAPER, LINE)
            text(x+28, 271, 'Add lead', 25, INK, True)
            field(x+28, 318, 'Title', typed('Solar pump installation',t,2.1,1.6), 840)
            field(x+28, 409, 'Source', 'Website' if t>4.6 else 'Choose a source', 400)
            field(x+458, 409, 'Owner', 'Alex Kim' if t>6.2 else 'Choose an owner', 410)
            field(x+28, 502, 'Account (optional)', '', 840)
            button(x+615, 675, 'Create', 250)
        if t<2: cx,cy,click=1080,294,1.5
        elif t<5.5: cx,cy,click=500,462,4.6
        elif t<8: cx,cy,click=935,462,6.2
        else: cx,cy,click=1060,701,10.1
    elif scene == 2:
        text(284, 270, 'Work order · WO-1042', 27, INK, True)
        text(284, 315, 'Inspect pump vibration', 22)
        pill(918, 272, 'Technician assigned' if t>=9.5 else 'Accepted')
        for x,label,value in [(284,'Station','West depot'),(595,'Contractor','Demo maintenance'),(938,'Technician','Alex Kim' if t>=9.5 else 'Unassigned')]:
            text(x, 382, label, 18, MUTED)
            text(x, 416, value, 21, INK, True)
        d.line((284,475,1192,475),LINE,1)
        text(284, 503, 'Assign a technician' if t<9.5 else 'Assignment timeline', 24, INK, True)
        if t<9.5:
            field(284, 553, 'Technician', 'Alex Kim' if t>=5 else 'Choose a technician', 620)
            if 3<t<5:
                box(284, 632, 620, 45, '#e9edf3', LINE)
                text(300,641,'Alex Kim',21)
            button(930, 589, 'Assign technician', 266)
        else:
            for i, label in enumerate(['Created','Contractor accepted','Technician assigned']):
                x=310+i*302
                d.ellipse((x,583,x+15,598),fill='#a9822e')
                if i<2: d.line((x+15,590,x+302,590),LINE,3)
                text(x-15,618,label,18)
            text(284, 702, 'Alex Kim can now review and accept the assignment.', 21, MUTED)
        cx,cy,click=(540,653,5) if t<7 else (1070,616,9.4)
    else:
        text(284, 269, 'New action plan' if t<11 else 'Action plan', 27, INK, True)
        field(284, 322, 'Work paper (observation)', 'Access approvals not documented', 908)
        field(284, 415, 'Action description', typed('Record approval for every access review.',t,1.3,2.6), 908)
        field(284, 508, 'Priority', 'Medium', 265)
        field(585, 508, 'Due date', '30 Oct 2026' if t>5.5 else '', 265)
        field(885, 508, 'Owners', 'Alex Kim' if t>7 else '', 307)
        if t<11:
            button(932, 687, 'Create action plan', 264)
        else:
            pill(284, 682, 'Action plan created')
            text(284, 731, 'Observation, owner and due date connected.', 21, MUTED)
        cx,cy,click=(1010,559,7) if t<9 else (1066,712,10.9)
    # A moving pointer and brief pulse show the causal action, not just changed text.
    if t < 12:
        travel=ease((t%2)/.8)
        px=cx+30*(1-travel); py=cy+20*(1-travel)
        if click is not None and 0<=t-click<.65:
            radius=10+32*(t-click)/.65
            d.ellipse((px-radius,py-radius,px+radius,py+radius),outline='#b18b36',width=3)
        d.polygon([(px,py),(px+4,24+py),(px+10,17+py),(px+20,16+py)],fill=INK,outline=WHITE,width=2)
    text(42, 807, f'{product.lower()}.murikah.com', 19, WHITE)
    text(735, 807, 'UI DEMONSTRATION · SAMPLE RECORDS', 16, '#b8c4c8')
    return im

if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    frame(11).save(OUT/'murikah-hero.jpg', quality=90)
    process = subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-crf','23','-preset','medium','-pix_fmt','yuv420p','-movflags','+faststart',str(OUT/'murikah-hero.mp4')], stdin=subprocess.PIPE)
    for i in range(FPS*SECONDS):
        process.stdin.write(frame(i/FPS).tobytes())
    process.stdin.close()
    if process.wait():
        raise SystemExit('ffmpeg render failed')
