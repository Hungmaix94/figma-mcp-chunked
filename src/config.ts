import fs from 'fs';

interface Config {
  figmaAccessToken: string;
}

export function loadConfig(): Config {
  const configArg = process.argv.find((arg) => arg.startsWith('--config='));
  if (configArg) {
    const configPath = configArg.split('=')[1];
    try {
      console.error('[MCP Debug] Loading config from', configPath);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const token = config.mcpServers?.figma?.env?.FIGMA_ACCESS_TOKEN;
      if (token) {
        console.error('[MCP Debug] Config loaded successfully');
        return { figmaAccessToken: token };
      }
    } catch (error) {
      console.error('[MCP Error] Failed to load config', error);
    }
  }

  const token = process.env.FIGMA_ACCESS_TOKEN;
  if (!token) {
    console.error('[MCP Error] FIGMA_ACCESS_TOKEN not found');
    throw new Error(
      'FIGMA_ACCESS_TOKEN is required. Provide it via environment variable or config file.'
    );
  }

  console.error('[MCP Debug] Using FIGMA_ACCESS_TOKEN from environment');
  return { figmaAccessToken: token };
}

export function getFigmaAccessToken(): string {
  const { figmaAccessToken } = loadConfig();
  console.error(
    '[MCP Debug] Access token found',
    figmaAccessToken.substring(0, 8) + '...'
  );
  return figmaAccessToken;
}
