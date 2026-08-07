'use strict'
const NON_CONTENT_SEO_LEVELS = new Set(['Essential'])
const TEST_ROW_NAME = /^(test|sample)\b/i
const EXCLUDED_CONTENT_CLIENT_IDS = new Set(['a001593a-ce1c-4da4-bd67-46a33ee7437c'])
function filterRoster(rows)  {
  return (rows || []).filter(row =>  {
    const level = typeof row.seo_level === 'string' ? row.seo_level.trim() : ''
    return level && !NON_CONTENT_SEO_LEVELS.has(level) && !TEST_ROW_NAME.test(row.name || '') && !EXCLUDED_CONTENT_CLIENT_IDS.has(row.id)
  })
}
async function loadRoster(supabase)  {
  const  {
    data, error
  }
  = await supabase.from('client').select('id,name,status,seo_level,website,gsc_property_url').in('status', ['Live', 'Onboarding'])
  if (error) throw new Error(`roster: ${error.message}`)
  return filterRoster(data)
}
module.exports =  {
  NON_CONTENT_SEO_LEVELS, TEST_ROW_NAME, EXCLUDED_CONTENT_CLIENT_IDS, filterRoster, loadRoster
}
