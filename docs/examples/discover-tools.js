// Use only in a delegate granted codemode, the selected server and the relevant exact tools.
// Discover first; call tools in a later script after reading their declarations.
const namespace = "mcp__exa";
const server = await describeNamespace(namespace);
const matches = await searchTools("search official documentation", { namespace, limit: 2 });
return {
  server,
  declarations: await Promise.all(matches.map(async tool => ({ name: tool.name, declaration: await describeTool(tool.name) }))),
};
// describeTool returns a string, not an object. MCP calls return CallToolResult:
// const result = await tools.<verified_name>(<verified_arguments>);
// Check result.isError before using result.structuredContent or result.content.
