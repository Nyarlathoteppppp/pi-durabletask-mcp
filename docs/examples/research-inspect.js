// Reuse this session's saved pages without another network call.
const pages = load('research.pages') || [];
const terms = ['tools', 'models', 'chat', 'callable'];
for (const page of pages) {
  if (!page.ok || page.result?.isError) {
    text({ url: page.url, ok: false, error: page.error ?? "MCP page returned an error" });
    continue;
  }
  const body = (page.result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const lines = body.split('\n');
  const indexes = new Set();
  for (const [i, line] of lines.entries()) {
    if (terms.some(term => line.toLowerCase().includes(term)))
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) indexes.add(j);
  }
  text({ url: page.url, excerpts: [...indexes].sort((a,b) => a-b).map(i => lines[i]).join('\n') });
}
if (!pages.length) text({ unavailable: true, reason: 'No saved pages in this session' });
