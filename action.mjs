import { Problem, plain, record, rejectSecrets, run, uuid } from './runner.mjs';

function markdownLiteral(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/:/g, '&#58;').replace(/@/g, '&#64;');
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(text) {
  return text.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
    const hex = entity[1]?.toLowerCase() === 'x';
    const n = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
  });
}

export function markdownBody(html) {
  if (!plain(html)) throw new Problem('invalid_markdown_source');
  let output = '';
  let ordered = false;
  for (const part of html.replace(/<!--[\s\S]*?-->/g, '').split(/(<\/?[a-z][^>]*>)/gi)) {
    if (!part.startsWith('<') || !part.endsWith('>')) {
      output += markdownLiteral(decode(part));
      continue;
    }
    const tag = part.toLowerCase();
    if (/^<h[2-4]>$/.test(tag)) output += '\n\n' + '#'.repeat(Number(tag[2])) + ' ';
    else if (/^<\/(?:p|h[2-4]|ol|ul|blockquote)>$/.test(tag)) output += '\n\n';
    else if (tag === '<ol>') { ordered = true; output += '\n'; }
    else if (tag === '<ul>') { ordered = false; output += '\n'; }
    else if (tag === '<li>') output += ordered ? '1. ' : '- ';
    else if (tag === '</li>' || /^<br\s*\/?\s*>$/.test(tag)) output += '\n';
    // Links, attributes and active markup never carry through to a draft.
  }
  return output.replace(/\n{3,}/g, '\n\n').trim();
}

const locales = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

export const action = {
  file: 'generated/content.md',
  extensions: ['.md'],
  async execute(ctx) {
    const { post, poll, text, select, requestId, ceiling, token } = ctx;
    const mode = select('kind', ['article', 'seo', 'product'], 'article');
    const language = text('language', 2, 12, 'en');
    if (!locales.test(language)) throw new Problem('invalid_language');
    const cap = ceiling();
    if (mode === 'product') {
      const product = { name: text('topic', 2, 200), description: text('product_facts', 1, 6000) };
      const tone = select('tone', ['neutral', 'friendly', 'premium', 'expert', 'playful', 'minimal'], 'neutral');
      const body = { action: 'fill_text', request_id: requestId, product, locale: language,
        options: { fields: ['title', 'description', 'short_description', 'seo'], tone } };
      const account = await post('/store', { action: 'account' });
      if (!Number.isSafeInteger(account.prices?.text) || account.prices.text > cap) throw new Problem('credit_limit_exceeded');
      const result = await poll(() => post('/store', body), value => value.status !== 'running', 10_000);
      if (result.status !== 'complete' || result.request_id !== requestId || !record(result.result)) throw new Problem('product_generation_not_complete');
      const value = result.result;
      rejectSecrets(JSON.stringify(value), token);
      const title = value.title || product.name;
      const bodyMd = markdownBody(value.description_html || value.short_description_html);
      const seo = value.seo ? '\n\n## SEO\n\n- Title: ' + markdownLiteral(value.seo.title ?? '') +
        '\n- Description: ' + markdownLiteral(value.seo.description ?? '') : '';
      return { status: 'complete', bytes: '# ' + markdownLiteral(title) + '\n\n' + bodyMd + seo + '\n', credits: result.credits_charged };
    }
    const topic = text('topic', 3, 200);
    const words = Number(select('words', ['500', '1000', '1500', '2000', '3000'], '500'));
    const style = select('style', ['expert', 'sales', 'informational', 'conversational'], 'informational');
    const keywords = mode === 'seo' ? text('keywords', 1, 500).split(/[,;\n]/).map(word => word.trim()).filter(Boolean) : [];
    if ((mode === 'seo' && keywords.length === 0) || keywords.length > 12 || keywords.some(word => word.length > 80)) throw new Problem('invalid_keywords');
    const audience = text('audience', 0, 300);
    const quote = await post('/blog', { action: 'quote', words, count: 1, with_images: false });
    // Trial availability can change between queueing and the worker claim.
    const expected = quote.max_credits;
    const fullPrice = quote.text_credits_per_article;
    if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(fullPrice) ||
      expected < 0 || fullPrice < expected || fullPrice > cap) throw new Problem('credit_limit_exceeded');
    const start = { action: 'start', request_id: requestId, expected_credits: expected,
      brief: { mode: 'topic', prompt: topic, language, words, style, audience, keywords, with_images: false },
      topics: [{ topic, keywords }] };
    // The API deduplicates start by UUID + normalized brief. Never change the
    // quoted price during an automatic retry.
    const initial = await poll(() => post('/blog', start), () => true, 10_000);
    const jobId = initial.job?.id;
    if (!uuid.test(jobId ?? '')) throw new Problem('invalid_blog_job');
    const completed = await poll(() => post('/blog', { action: 'job', job_id: jobId }), value => {
      if (!Array.isArray(value.articles) || value.articles.length !== 1 || value.job?.id !== jobId) throw new Problem('invalid_blog_job');
      return !['queued', 'running'].includes(value.articles[0]?.status);
    });
    const finished = completed.articles[0];
    if (finished.status !== 'complete' || !uuid.test(finished.id ?? '')) throw new Problem('blog_generation_not_complete');
    const { article } = await post('/blog', { action: 'article', article_id: finished.id });
    const value = article?.content;
    if (value) rejectSecrets(JSON.stringify(value), token);
    if (article?.id !== finished.id || !plain(value?.title, 1, 200)) throw new Problem('invalid_blog_article');
    let md = '# ' + markdownLiteral(value.title) + '\n\n' + markdownBody(value.content_html);
    if (mode === 'seo') md += '\n\n## SEO\n\n- Title: ' + markdownLiteral(value.seo_title ?? '') +
      '\n- Description: ' + markdownLiteral(value.meta_description ?? '') + '\n- Slug: ' + markdownLiteral(value.slug ?? '');
    return { status: 'complete', bytes: md + '\n', credits: finished.credits_charged };
  },
};

export const execute = options => run(action, options);
