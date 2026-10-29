"""Capture the real browser-only sandbox. Requires Playwright, Chromium and Pillow.
Run after building and starting the local Worker: python scripts/marketing/capture-assurance-screens.py
No production login, client records or network image service is used.
"""
from pathlib import Path
from io import BytesIO
import base64
import os
from PIL import Image
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parents[2] / 'public/images/assurance-os'
BASE = os.environ.get('HOMEWEB_PREVIEW_URL', 'http://127.0.0.1:8791')

def export(raw, name):
    image = Image.open(BytesIO(raw)).convert('RGB')
    image.thumbnail((1560, 960), Image.Resampling.LANCZOS)
    canvas = Image.new('RGB', (1600, 1000), '#f7f5f0')
    canvas.paste(image, ((1600-image.width)//2, (1000-image.height)//2))
    for quality in (88, 82, 75, 68):
        canvas.save(OUT / f'{name}.webp', 'WEBP', quality=quality, method=6)
        if (OUT / f'{name}.webp').stat().st_size < 150_000:
            break
    assert (OUT / f'{name}.webp').stat().st_size < 150_000

def data_url(raw):
    return 'data:image/png;base64,' + base64.b64encode(raw).decode()

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1600,'height':1100}, device_scale_factor=1, reduced_motion='reduce')
    # The sandbox derives dates from the current day; fix capture dates for reproducibility.
    page.clock.install(time='2026-10-29T09:00:00Z')
    page.goto(BASE + '/assurance-os/sandbox', wait_until='networkidle')
    page.locator('.sb-root').scroll_into_view_if_needed()
    page.get_by_role('button', name='Dismiss', exact=True).click()
    page.get_by_role('button', name='Open full screen', exact=True).click()
    def nav(screen):
        page.locator(f'.sb-nav button[data-tour="{screen}"]').click()
        page.locator('.sb-screen h1').wait_for()
        page.wait_for_timeout(250)
    def shot(name):
        export(page.locator('.sb-screen').screenshot(), name)
    nav('plan'); shot('plan')
    nav('engagements')
    page.locator('.sb-screen tbody tr').first.click()
    page.get_by_role('tab', name='Work papers', exact=True).click()
    page.locator('.sb-screen tbody tr').first.click()
    shot('fieldwork')
    # A crop from the actual work-paper review thread, without altering content.
    review = page.locator('.sb-panel').filter(has=page.get_by_role('heading', name='Review notes', exact=True))
    export(review.screenshot(), 'review')
    nav('actions'); shot('remediation')
    nav('reports')
    page.get_by_role('button', name='Generate quarterly committee pack', exact=True).click()
    page.locator('#sandbox-report-preview').wait_for()
    report = page.locator('.sb-report-cover').screenshot()
    export(page.locator('.sb-report-page').nth(1).screenshot(), 'report')
    nav('findings')
    # Crop the first three genuine rows (Low, High, Medium), retaining the UI's count and filter bar.
    screen = page.locator('.sb-screen').bounding_box()
    third = page.locator('.sb-screen tbody tr').nth(2).bounding_box()
    raw = page.screenshot(clip={'x':screen['x'], 'y':screen['y'], 'width':screen['width'], 'height':third['y']+third['height']-screen['y']})
    export(raw, 'findings')
    # Editorial arrangement of two unaltered product captures, explicitly labelled sample data.
    composition = browser.new_page(viewport={'width':1600,'height':1000}, device_scale_factor=1)
    composition.set_content(f'''<html><style>
      *{{box-sizing:border-box}}body{{margin:0;background:#f7f5f0;color:#071d35;font:24px Arial,sans-serif}}
      header{{padding:45px 55px;display:flex;justify-content:space-between;border-bottom:1px solid #d7d2c8}}
      header strong{{font-size:32px}}header span{{color:#56616d}}
      .findings{{position:absolute;left:45px;top:160px;width:1490px;border:1px solid #d7d2c8;border-radius:12px;box-shadow:0 16px 40px #071d3518}}
      figure{{position:absolute;right:45px;bottom:35px;width:410px;margin:0;background:white;border:1px solid #d7d2c8;border-radius:12px;overflow:hidden;box-shadow:0 16px 40px #071d3528}}
      figcaption{{padding:16px 24px;background:#071d35;color:white;font-size:24px}}figure img{{width:100%;display:block}}
      .note{{position:absolute;bottom:55px;left:55px;font-size:24px;color:#56616d}}
      </style><header><strong>Assurance OS</strong><span>Fictional sandbox data</span></header>
      <img class="findings" src="{data_url(raw)}" alt="Finding register"/>
      <p class="note">From findings to the committee pack.</p>
      <figure><figcaption>Board pack</figcaption><img src="{data_url(report)}" alt="Sample quarterly committee pack"/></figure></html>''')
    composition.locator('img').first.wait_for()
    composition.wait_for_timeout(200)
    Image.open(BytesIO(composition.screenshot())).convert('RGB').save(OUT/'hero.webp','WEBP',quality=86,method=6)
    assert (OUT/'hero.webp').stat().st_size < 150_000
    browser.close()
for file in sorted(OUT.glob('*.webp')):
    print(file.name, Image.open(file).size, file.stat().st_size)
