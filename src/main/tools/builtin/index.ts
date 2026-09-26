import type { ToolRegistry } from '../registry';
import { currentDatetimeTool } from './datetime';
import { webFetchTool } from './web-fetch';
import { createWebSearchTool } from './web-search';

export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(currentDatetimeTool);
  registry.register(createWebSearchTool());
  registry.register(webFetchTool);
}
