"""Exercise the built GA4 client with a test ID fixture; block all Google requests.
No real measurement ID or analytics account is required, and no data is sent.
"""
import os
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('HOMEWEB_PREVIEW_URL','http://127.0.0.1:8791')
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 context=b.new_context(viewport={'width':1440,'height':1000})
 google=[]
 context.route('https://www.googletagmanager.com/**',lambda route:(google.append(route.request.url),route.fulfill(status=200,content_type='application/javascript',body='/* GA stub: no transmission */')))
 context.route('https://*.google-analytics.com/**',lambda route:route.abort())
 page=context.new_page()
 page.goto(BASE,wait_until='networkidle')
 assert page.locator('[data-analytics-consent]').count()==0
 assert google==[]
 # The production build has no ID. Supply only the conditional panel as a fixture;
 # all behaviour still runs through the actual compiled GoogleAnalytics component.
 fixture='<aside data-analytics-consent data-measurement-id="G-TEST12345" hidden><button data-analytics-accept>Allow analytics</button><button data-analytics-decline>No thanks</button></aside>'
 def inject(route):
  response=route.fetch()
  route.fulfill(response=response,body=response.text().replace('</body>',fixture+'</body>'))
 page.route(BASE+'/',inject)
 page.goto(BASE,wait_until='networkidle')
 expect(page.locator('[data-analytics-consent]')).to_be_visible()
 assert google==[]
 page.locator('[data-analytics-decline]').click()
 page.reload(wait_until='networkidle')
 expect(page.locator('[data-analytics-consent]')).to_be_hidden()
 assert google==[]
 page.locator('[data-analytics-settings]').click()
 page.locator('[data-analytics-accept]').click()
 page.wait_for_timeout(300)
 assert len(google)==1
 commands=page.evaluate('(window.dataLayer||[]).map(entry=>Array.from(entry))')
 config=next(command for command in commands if command[0:1]==['config'])
 assert config[1]=='G-TEST12345'
 assert config[2]['send_page_view'] is False
 assert config[2]['allow_google_signals'] is False
 assert config[2]['page_location']==BASE+'/'
 page.evaluate("document.addEventListener('click',e=>{if(e.target.closest('a'))e.preventDefault();})")
 page.locator('.home-hero__primary').click()
 commands=page.evaluate('(window.dataLayer||[]).map(entry=>Array.from(entry))')
 event=next(command for command in commands if command[0:2]==['event','cta_call_click'])
 assert event[2]=={'location':'hero'}
 page.locator('[data-analytics-settings]').click();page.locator('[data-analytics-decline]').click()
 page.wait_for_load_state('networkidle')
 assert len(google)==1
 assert page.evaluate("localStorage.getItem('murikah-analytics-consent')")=='denied'
 print('GA disabled without ID; consent grant/decline/withdrawal, safe configuration and conversion forwarding passed. All Google requests were intercepted.')
 b.close()
