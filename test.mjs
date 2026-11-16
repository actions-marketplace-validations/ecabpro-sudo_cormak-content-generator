import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from './action.mjs';

const request_id = '12345678-1234-4234-8234-123456789abc';
const job = { id: '12345678-1234-4234-8234-123456789abd' };
const articleId = '12345678-1234-4234-8234-123456789abe';
const token = 'cmcp_a_' + 'x'.repeat(43);
const env = async overrides => ({
  GITHUB_WORKSPACE: await mkdtemp(join(tmpdir(), 'cormak-content-')), CORMAK_API_KEY: token,
  INPUT_REQUEST_ID: request_id, INPUT_ALLOW_PAID: 'true', INPUT_MAX_CREDITS: '2', INPUT_TOPIC: 'A repairable lamp',
  ...overrides,
});
const response = (data, status = 200) => Response.json(data, { status });
const silence = () => {};
test('Blog SEO quotes, retries the identical start, polls and saves inert Markdown', async () => {
  const inputs = await env({ INPUT_KIND: 'seo', INPUT_KEYWORDS: 'desk lamps, repairability' });
  const calls = [];
  const result = await execute({ env: inputs, log: silence, pause: silence, fetcher: async (url, options) => {
    assert.equal(url, 'https://mcp.cormak.app/blog');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    const body = JSON.parse(options.body);
    calls.push(body);
    switch (calls.length) {
      case 1: assert.deepEqual(body, { action: 'quote', words: 500, count: 1, with_images: false });
        return response({ max_credits: 0, text_credits_per_article: 1 });
      case 2: assert.deepEqual(body.topics, [{ topic: 'A repairable lamp', keywords: ['desk lamps', 'repairability'] }]);
        return response({ error: 'upstream' }, 503);
      case 3: assert.deepEqual(body, calls[1]); assert.equal(body.request_id, request_id); assert.equal(body.expected_credits, 0);
        return response({ job, articles: [] });
      case 4: assert.deepEqual(body, { action: 'job', job_id: job.id }); return response({ job, articles: [{ status: 'running' }] });
      case 5: assert.deepEqual(body, calls[3]); return response({ job, articles: [{ id: articleId, status: 'complete', credits_charged: 0 }] });
      case 6: assert.deepEqual(body, { action: 'article', article_id: articleId });
        return response({ article: { id: articleId, content: {
          title: 'Lamp care', content_html: '<h2>Parts</h2><p>&lt;tag&gt; <a href="https://example.com">manual</a></p><ul><li>A &amp; B</li></ul>',
          seo_title: 'Lamp care', meta_description: 'Maintenance FAQ', slug: 'lamp-care',
        } } });
      default: throw new Error('unexpected call');
    }
  } });
  assert.deepEqual(result, { request_id, status: 'complete', output_path: 'generated/content.md', credits_charged: 0 });
  assert.equal(calls.length, 6);
  const md = await readFile(join(inputs.GITHUB_WORKSPACE, result.output_path), 'utf8');
  assert.match(md, /^# Lamp care\n\n## Parts/);
  assert.match(md, /- A &amp; B/);
  assert.match(md, /## SEO/);
  assert.doesNotMatch(md, /https:\/\/|<tag>/);
});
test('Product copy uses the durable Store request and renders returned facts', async () => {
  const inputs = await env({ INPUT_KIND: 'product', INPUT_PRODUCT_FACTS: 'Replaceable knob', INPUT_TONE: 'minimal' });
  const calls = [];
  await execute({ env: inputs, log: silence, pause: silence, fetcher: async (url, options) => {
    assert.ok(url.endsWith('/store'));
    const body = JSON.parse(options.body); calls.push(body);
    if (body.action === 'account') return response({ prices: { text: 1 } });
    if (calls.length === 2) {
      assert.equal(body.product.description, 'Replaceable knob'); assert.equal(body.options.tone, 'minimal');
      return response({ request_id, status: 'running' }, 202);
    }
    assert.deepEqual(body, calls[1]);
    return response({ request_id, status: 'complete', credits_charged: 1, result: { description_html: '<p>Replaceable knob.</p>' } });
  } });
  assert.match(await readFile(join(inputs.GITHUB_WORKSPACE, 'generated/content.md'), 'utf8'), /Replaceable knob/);
});
test('Checks the full article price even if the account has a free article', async () => {
  const inputs = await env({ INPUT_MAX_CREDITS: '0' });
  const calls = [];
  await assert.rejects(execute({ env: inputs, log: silence, fetcher: async (_url, options) => {
    calls.push(JSON.parse(options.body).action);
    return response({ max_credits: 0, text_credits_per_article: 1 });
  } }), /credit_limit_exceeded/);
  assert.deepEqual(calls, ['quote']);
});
test('Refuses paid work, escaped paths, an existing file, and secret input before fetch', async () => {
  const fetcher = () => assert.fail('no request expected');
  for (const [override, error] of [
    [{ INPUT_ALLOW_PAID: '' }, /paid_run_disabled/],
    [{ INPUT_OUTPUT_PATH: 'generated/../README.md' }, /invalid_workspace_path/],
    [{ INPUT_TOPIC: token }, /possible_secret_detected/],
  ]) await assert.rejects(execute({ env: await env(override), log: silence, fetcher }), error);
  const inputs = await env({ INPUT_OUTPUT_PATH: 'generated.md' });
  const file = join(inputs.GITHUB_WORKSPACE, 'generated.md');
  await writeFile(file, 'protected');
  await assert.rejects(execute({ env: inputs, log: silence, fetcher }), /invalid_workspace_path/);
  assert.equal(await readFile(file, 'utf8'), 'protected');
});
