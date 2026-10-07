const queries = [
  'Pi official MCP documentation exposure direct deferred codemode',
  'Pi official codemode documentation Promise.allSettled tool composition'
];
const searches = [];
store('research.pages', []);
for (const query of queries) {
  try {
    const result = await tools.mcp__exa__web_search_exa({ query, objective: 'Find official pi.dev documentation for the stated feature; exclude unrelated Pi projects.', numResults: 2 });
    searches.push({ query, ok: true, result });
  } catch (error) {
    searches.push({ query, ok: false, error: String(error) });
  }
}
store('research.searches', searches);
text({ searches: searches.map(({ result, ...summary }) => summary) });
if (searches.some(result => result.ok)) {
  const urls = ['https://pi.dev/docs/latest/mcp', 'https://pi.dev/docs/latest/codemode'];
  const pages = await Promise.allSettled(urls.map(url => tools.mcp__exa__web_fetch_exa({ urls: [url], maxCharacters: 7000 })));
  const saved = [];
  for (const [i, page] of pages.entries()) {
    if (page.status === 'fulfilled') {
      saved.push({ url: urls[i], ok: true, result: page.value });
      const body = (page.value.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      text({ url: urls[i], ok: true, preview: body.slice(0, 1200) });
    } else {
      const failed = { url: urls[i], ok: false, error: String(page.reason) };
      saved.push(failed);
      text(failed);
    }
  }
  store('research.pages', saved);
} else text({ skippedFetch: true, reason: 'No successful search' });
