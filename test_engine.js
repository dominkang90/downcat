'use strict';
const assert = require('assert');
const { download, extractItemLinks, resolveEmbeddedSource, ytdlpArgs } = require('./engine');

(async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: true,
    text: async () => `const sourceUrl = "https:\/\/cdn.example\/${new URL(url).searchParams.get('items_id')}\/items1.m3u8";`,
  });
  try {
    const urls = [
      'https://yasyadong02.tv/?_Action=items&items_id=31924',
      'https://yasyadong02.tv/?_Action=items&items_id=31923',
    ];
    const outputs = [];
    for (const url of urls) {
      const resolved = await resolveEmbeddedSource(url);
      const args = ytdlpArgs(resolved.url, 'downloads', { outputPrefix: resolved.outputPrefix });
      outputs.push(args[args.indexOf('-o') + 1]);
    }
    assert.notStrictEqual(outputs[0], outputs[1]);
    assert(outputs[0].includes('yasyadong02.tv-31924 %(title)s'));

    assert.deepStrictEqual(extractItemLinks(
      '<a href="/?_Action=items&amp;items_id=7"></a><a href="/?_Action=items&items_id=7"></a><a href="/?_Action=items&items_id=8"></a>',
      'https://yasyadong02.tv/',
    ), [
      'https://yasyadong02.tv/?_Action=items&items_id=7',
      'https://yasyadong02.tv/?_Action=items&items_id=8',
    ]);

    let fetched = false;
    global.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
    assert.strictEqual(await resolveEmbeddedSource('https://example.com/?_Action=items&items_id=1'), null);
    assert.strictEqual(fetched, false);

    const polite = ytdlpArgs('https://cdn.example/items1.m3u8', 'downloads', { polite: true });
    assert(polite.includes('sleep'));
    assert(polite.includes('http:exp=5:60'));
    assert.strictEqual(polite.filter((arg) => arg === '--retry-sleep').length, 2);

    global.fetch = async () => { const error = new Error('fetch failed'); error.cause = { code: 'ECONNRESET' }; throw error; };
    const reset = await resolveEmbeddedSource(urls[0]);
    assert.strictEqual(reset.error, '페이지 연결 실패: ECONNRESET');

    global.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const ac = new AbortController();
    const canceledDownload = download(urls[0], { outDir: 'downloads', signal: ac.signal });
    ac.abort();
    assert.strictEqual((await canceledDownload).canceled, true);
    console.log('ok - embedded videos get distinct output paths');
  } finally {
    global.fetch = realFetch;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
