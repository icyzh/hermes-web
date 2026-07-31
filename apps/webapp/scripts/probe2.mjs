import { chromium } from '@playwright/test'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://127.0.0.1:9119/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(9000)

const info = await page.evaluate(() => {
  const el = document.querySelector('.group\\/sidebar-wrapper')
  const cs = el ? getComputedStyle(el) : null
  const stylesheets = Array.from(document.styleSheets).map(s => {
    let rules = -1
    try { rules = s.cssRules.length } catch { rules = -2 }
    return `${s.href || '(inline)'} rules=${rules}`
  })
  // Does the built CSS define --spacing / tailwind theme vars?
  const rootCs = getComputedStyle(document.documentElement)
  return {
    innerSize: `${window.innerWidth}x${window.innerHeight}`,
    el: el ? {
      height: cs.height,
      display: cs.display,
      position: cs.position,
      flex: cs.flex,
      classListLen: el.classList.length
    } : null,
    parentChain: (() => {
      const chain = []
      let node = el
      while (node && node !== document.body) {
        const c = getComputedStyle(node)
        chain.push(`${node.tagName}#${node.id || ''} h=${c.height} disp=${c.display} pos=${c.position}`)
        node = node.parentElement
      }
      return chain
    })(),
    spacingVar: rootCs.getPropertyValue('--spacing') || '(none)',
    sidebarWidthVar: rootCs.getPropertyValue('--sidebar-width') || '(none)',
    stylesheets
  }
})
console.log(JSON.stringify(info, null, 1))
await browser.close()
