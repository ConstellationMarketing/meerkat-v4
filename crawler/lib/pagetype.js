'use strict'

function getPageType(input) {
  let pathname
  try {
    pathname = new URL(input, 'https://example.invalid').pathname.toLowerCase()
  } catch {
    pathname = String(input || '').toLowerCase()
  }

  if (
    /\/(blog|news|articles)(\/|$)/.test(pathname) ||
    /\/\d{4}\/\d{2}(\/|$)/.test(pathname)
  ) {
    return 'Blog Post'
  }

  if (
    /(lawyer|attorney|law-firm|dui|dwi|injury|accident|divorce|custody|defense|compensation|malpractice|bankruptcy|estate|immigration|visa)/.test(pathname) ||
    /-(lawyer|attorney)\/?$/.test(pathname)
  ) {
    return 'Practice Area'
  }

  if (
    /(about|contact|team|attorney-profile|our-firm|privacy|terms|sitemap|thank-you|testimonials|reviews|faq)/.test(pathname)
  ) {
    return 'Page'
  }

  if (pathname === '/' || pathname === '') return 'Page'
  return 'Resource'
}

module.exports = { getPageType }