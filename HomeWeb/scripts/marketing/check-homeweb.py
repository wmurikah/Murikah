"""Browser acceptance checks against a built, local HomeWeb Worker.
Requires Python Playwright and Chromium; no production form submissions are made.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('HOMEWEB_PREVIEW_URL','http://127.0.0.1:8791')
OUT=Path('/tmp/homeweb-review');OUT.mkdir(exist_ok=True)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=b.new_page(viewport={'width':1440,'height':1000},reduced_motion='reduce')
 errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
 for route in ['/', '/assurance-os', '/pricing', '/contact?intent=call&segment=fintech', '/insights', '/about', '/proof/report-extract', '/assurance-os/sandbox', '/privacy', '/terms', '/training', '/insights/iso-42001-readiness/']:
  response=page.goto(BASE+route,wait_until='networkidle')
  assert response.status==200,(route,response.status)
  assert not page.locator('body').inner_text().lower().count('founder'),route
  assert '{{LEGAL' not in page.locator('body').inner_text(),route
  assert '{{ACADEMY' not in page.locator('body').inner_text(),route
  print('route OK',route)
 page.goto(BASE,wait_until='networkidle')
 expect(page.locator('#hero img')).to_have_js_property('naturalWidth',1600)
 assert page.locator('#hero img').get_attribute('fetchpriority')=='high'
 for width in [1440,1024,390,320]:
  page.set_viewport_size({'width':width,'height':1000})
  page.screenshot(path=str(OUT/f'home-{width}.png'),full_page=True)
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'overflow at {width}'
  hero=page.locator('.home-hero__media').bounding_box();copy=page.locator('.home-hero__copy').bounding_box()
  if width>=1024:assert hero['x']>copy['x']+copy['width']-2
  else:assert hero['y']>=copy['y']+copy['height']
  assert page.locator('#contact-form [name=company_website]').bounding_box()['x']<0
 page.set_viewport_size({'width':390,'height':1000})
 page.get_by_role('button',name='Open menu',exact=True).click()
 expect(page.locator('[data-mobile-panel]')).to_be_visible()
 assert page.locator('[data-mobile-panel] details').count()==1
 page.keyboard.press('Escape');expect(page.locator('[data-mobile-panel]')).to_be_hidden()
 page.set_viewport_size({'width':1440,'height':1000})
 page.locator('.aw-card').scroll_into_view_if_needed()
 page.wait_for_timeout(300)
 assert page.locator('.aw-playpause').count()==0
 for name in ['Plan','Fieldwork','Review','Findings','Remediation','Report']:
  page.locator('.aw-tabs').get_by_role('button',name=name,exact=True).click()
  expect(page.locator('.aw-panel h3')).to_have_text(name)
  expect(page.locator('.aw-panel img')).to_have_js_property('complete',True)
  assert page.locator('.aw-panel img').evaluate('(e)=>e.naturalWidth')==1600
  assert page.locator('.aw-panel [aria-live]').get_attribute('aria-live')=='polite'
 print('responsive layout, mobile menu, reduced motion and six stages OK')
 page.goto(BASE+'/insights',wait_until='networkidle')
 page.get_by_role('button',name='AI governance',exact=True).click()
 assert page.locator('[data-insight-category]:visible').count()>0
 assert page.locator('[data-insight-category]:visible').evaluate_all('(els)=>els.every(e=>e.dataset.insightCategory==="ai-governance")')
 page.get_by_role('button',name='All',exact=True).click()
 assert page.locator('[data-insight-category]:visible').count()==page.locator('[data-insight-category]').count()
 expect(page.get_by_role('link', name='Read the readiness guide →', exact=True)).to_have_attribute('href', '/insights/iso-42001-readiness/')
 print('Insights filters and published readiness-guide destination OK')
 page.goto(BASE+'/contact?intent=call&segment=fintech',wait_until='networkidle')
 inputs=page.locator('#contact-form input:not([type=hidden]):not([name=company_website])')
 assert inputs.count()==3
 assert page.locator('#message').get_attribute('required') is None
 submitted=[]
 def submit(route):
  submitted.append(route.request.post_data_json)
  route.fulfill(status=200,content_type='application/json',body=json.dumps({'ok':True,'message':'Test request received'}))
 page.route('**/api/contact',submit)
 page.locator('#name').fill('Sample Visitor');page.locator('#email').fill('sample@example.com')
 page.get_by_role('button',name='Request a 20-minute call',exact=True).click()
 expect(page.locator('#form-status')).to_have_text('Test request received')
 assert submitted[0]['message']=='' and submitted[0]['segment']=='fintech'
 events=page.evaluate('window.dataLayer')
 assert events==[{'event':'form_submit','location':'contact'}],events
 page.unroute('**/api/contact')
 # Exercise local API validation and bot handling without storing or sending any lead.
 response=page.request.post(BASE+'/api/contact',data={'name':'','email':'bad'},headers={'Accept':'application/json'})
 assert response.status==422,response.text()
 response=page.request.post(BASE+'/api/contact',data={'company_website':'bot'},headers={'Accept':'application/json'})
 assert response.status==200
 page.goto(BASE+'/contact?status=ok',wait_until='networkidle');expect(page.locator('#form-status')).to_contain_text("Thanks")
 print('optional challenge, segment attribution, success feedback and API validation OK')
 # Observe click events without navigating away.
 page.goto(BASE,wait_until='networkidle')
 page.evaluate("document.addEventListener('click',e=>{if(e.target.closest('a'))e.preventDefault();})")
 page.locator('.home-hero__primary').click();page.locator('.home-hero__secondary').click()
 events=page.evaluate('window.dataLayer')
 assert events==[{'event':'cta_call_click','location':'hero'},{'event':'sandbox_click','location':'hero'}],events
 page.goto(BASE+'/assurance-os/sandbox',wait_until='networkidle');page.locator('.sb-root').scroll_into_view_if_needed();page.wait_for_timeout(500)
 assert page.evaluate("window.dataLayer.filter(e=>e.event==='sandbox_start').length")==1
 print('conversion event hooks contain only event names and locations OK')
 # Advance browser time to check one complete automatic loop; no lengthy real wait.
 motion=b.new_page(viewport={'width':1440,'height':1000},reduced_motion='no-preference')
 motion.clock.install()
 motion.goto(BASE,wait_until='networkidle');motion.locator('.aw-card').scroll_into_view_if_needed();motion.mouse.move(0,0);motion.wait_for_timeout(400)
 assert motion.locator('.aw-panel [aria-live]').get_attribute('aria-live')=='off'
 motion.clock.run_for(17100);expect(motion.locator('.aw-panel h3')).to_have_text('Fieldwork')
 motion.locator('.aw-card').hover();motion.clock.run_for(18000);expect(motion.locator('.aw-panel h3')).to_have_text('Fieldwork')
 motion.mouse.move(0,0);motion.locator('.aw-tab').first.focus();motion.clock.run_for(18000);expect(motion.locator('.aw-panel h3')).to_have_text('Fieldwork')
 motion.locator('.aw-tab').first.evaluate('(e)=>e.blur()')
 for _ in range(5):motion.clock.run_for(17100)
 expect(motion.locator('.aw-panel h3')).to_have_text('Report');expect(motion.locator('.aw-playpause')).to_have_text('Play once')
 motion.clock.run_for(35000);expect(motion.locator('.aw-panel h3')).to_have_text('Report')
 print('autoplay pauses on hover/focus and stops after one loop OK')
 assert not errors,errors
 b.close()
print('All browser acceptance checks passed. Review images:',OUT)
