'use strict';

const { createClient } = require('@supabase/supabase-js');

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.body = { error: message, ...(extra || {}) };
  return err;
}

async function enrichArticles(articles) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { db: { schema: 'meerkat' } });
  const uniqueClients = [...new Set(articles.map(a => a.clientName))];
  const { data: folders, error: folderError } = await supabase.from('client_folders').select('name, id, website, client_info');
  if (folderError) throw httpError(500, `Failed to lookup clients: ${folderError.message}`);

  const normalizeClient = (s) => (s || '').toString().toLowerCase().replace(/[.,]/g, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const clientAliasToCanonical = {};
  const clientByCanonical = {};
  (folders || []).forEach(f => {
    const key = normalizeClient(f.name);
    if (key) clientAliasToCanonical[key] = f.name;
    clientByCanonical[f.name] = { clientId: f.id, website: f.website, clientInfo: f.client_info };
  });
  const resolveClient = (raw) => clientAliasToCanonical[normalizeClient(raw)] || null;
  const unresolved = uniqueClients.filter(c => resolveClient(c) === null);
  if (unresolved.length) throw httpError(400, `${unresolved.length} client(s) not found in client_folders`, { unresolved });

  const { data: templates, error: templateError } = await supabase.from('templates').select('id, name, sections');
  if (templateError) throw httpError(500, `Failed to lookup templates: ${templateError.message}`);
  const normalize = (s) => (s || '').toString().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const aliasToId = {};
  const templateMap = {};
  (templates || []).forEach(t => {
    if (!t.id) return;
    [t.id, t.name].forEach(alias => {
      const key = normalize(alias);
      if (key) aliasToId[key] = t.id;
    });
    templateMap[t.id] = t.sections;
  });
  const resolveTemplate = (raw) => {
    const candidate = (raw && raw.trim()) ? raw : 'practice-page';
    return aliasToId[normalize(candidate)] || null;
  };

  const unresolvedRawValues = [...new Set(articles.filter(a => resolveTemplate(a.template) === null).map(a => a.template || '(blank)'))];
  if (unresolvedRawValues.length) {
    throw httpError(400, `${unresolvedRawValues.length} template value(s) not found in Supabase templates table`, {
      unresolvedTemplates: unresolvedRawValues,
      hint: 'Use one of the template names or IDs from Settings \u2192 Templates. "Practice Page" / "Supporting Page" / "practice-page" / "supporting-page" all resolve.',
    });
  }
  const resolvedIds = [...new Set(articles.map(a => resolveTemplate(a.template)))];
  const emptySectionIds = resolvedIds.filter(id => !templateMap[id] || !Array.isArray(templateMap[id]) || templateMap[id].length === 0);
  if (emptySectionIds.length) {
    throw httpError(400, `${emptySectionIds.length} template(s) resolved but have no sections`, {
      unresolvedTemplates: emptySectionIds,
      hint: 'Edit the template via Settings \u2192 Templates and add at least one section.',
    });
  }

  return articles.map(a => {
    const canonicalName = resolveClient(a.clientName);
    const client = clientByCanonical[canonicalName];
    const templateId = resolveTemplate(a.template);
    return {
      keyword: a.keyword,
      clientName: canonicalName,
      clientId: client.clientId,
      clientInfo: client.clientInfo || '',
      website: client.website || '',
      template: templateId === 'practice-page' ? 'Practice Page' : 'Supporting/Resource Page',
      userId: a.userId || null,
      sections: (templateMap[templateId] || []).map((s, idx) => ({
        sectionNumber: idx + 1,
        name: s.title || s.name || `Section ${idx + 1}`,
        details: s.description || s.details || '',
        wordCount: s.wordCount || null,
      })),
    };
  });
}

module.exports = { enrichArticles };

