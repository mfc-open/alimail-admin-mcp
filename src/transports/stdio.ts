import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "../logger.js";
import { createMcpServer, type AppContext } from "../server.js";

export async function startStdio(app: AppContext): Promise<void> {
  const { server, tools } = createMcpServer(app);
  await server.connect(new StdioServerTransport());
  log.info("alimail-admin-mcp running on stdio", {
    readOnly: app.config.readOnly,
    toolsets: app.config.toolsets,
    tools: tools.length,
  });
}
