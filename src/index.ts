#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  Request,
} from '@modelcontextprotocol/sdk/types.js';
import { ChunkedFigmaClient } from './client.js';
import { getFigmaAccessToken } from './config.js';

interface ListFilesArgs {
  project_id?: string;
  team_id?: string;
}

interface FileKeyArgs {
  file_key: string;
}

interface FileNodesArgs extends FileKeyArgs {
  ids: string[];
}

interface GetFileDataArgs {
  file_key: string;
  pageSize?: number;
  maxMemoryMB?: number;
  nodeTypes?: string[];
  cursor?: string;
  depth?: number;
  maxResponseSize?: number;
  excludeProps?: string[];
  summarizeNodes?: boolean;
}

class FigmaMCPServer {
  private server: Server;
  private figmaClient: ChunkedFigmaClient;

  constructor() {
    console.error('[MCP Debug] Initializing Figma MCP server');
    this.server = new Server(
      {
        name: 'figma-mcp-chunked',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.figmaClient = new ChunkedFigmaClient(getFigmaAccessToken());
    this.setupToolHandlers();
    
    this.server.onerror = (error: Error) => {
      console.error('[MCP Error]', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
    };
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    console.error('[MCP Debug] Setting up tool handlers');
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_file_data',
          description: 'Get Figma file data with chunking and pagination',
          inputSchema: {
            type: 'object',
            properties: {
              file_key: {
                type: 'string',
                description: 'Figma file key'
              },
              pageSize: {
                type: 'number',
                description: 'Number of nodes per page',
                minimum: 1,
                maximum: 1000
              },
              maxMemoryMB: {
                type: 'number',
                description: 'Maximum memory usage in MB',
                minimum: 128,
                maximum: 2048
              },
              nodeTypes: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: [
                    'FRAME',
                    'GROUP',
                    'VECTOR',
                    'BOOLEAN_OPERATION',
                    'STAR',
                    'LINE',
                    'TEXT',
                    'COMPONENT',
                    'INSTANCE'
                  ]
                },
                description: 'Filter nodes by type'
              },
              cursor: {
                type: 'string',
                description: 'Pagination cursor for continuing from a previous request'
              },
              depth: {
                type: 'number',
                description: 'Maximum depth to traverse in the node tree',
                minimum: 1
              },
              maxResponseSize: {
                type: 'number',
                description: 'Maximum response size in MB (defaults to 50)',
                minimum: 1,
                maximum: 100
              },
              excludeProps: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: 'Properties to exclude from node data'
              },
              summarizeNodes: {
                type: 'boolean',
                description: 'Return only essential node properties to reduce response size'
              }
            },
            required: ['file_key']
          }
        },
        {
          name: 'list_files',
          description: 'List files in a project or team',
          inputSchema: {
            type: 'object',
            properties: {
              project_id: {
                type: 'string',
                description: 'Project ID to list files from'
              },
              team_id: {
                type: 'string',
                description: 'Team ID to list files from'
              }
            }
          }
        },
        {
          name: 'get_file_versions',
          description: 'Get version history of a Figma file',
          inputSchema: {
            type: 'object',
            properties: {
              file_key: {
                type: 'string',
                description: 'Figma file key'
              }
            },
            required: ['file_key']
          }
        },
        {
          name: 'get_file_comments',
          description: 'Get comments on a Figma file',
          inputSchema: {
            type: 'object',
            properties: {
              file_key: {
                type: 'string',
                description: 'Figma file key'
              }
            },
            required: ['file_key']
          }
        },
        {
          name: 'get_components',
          description: 'Get components from a Figma file',
          inputSchema: {
            type: 'object',
            properties: {
              file_key: {
                type: 'string',
                description: 'Figma file key'
              }
            },
            required: ['file_key']
          }
        },
        {
          name: 'get_styles',
          description: 'Get styles from a Figma file',
          inputSchema: {
            type: 'object',
            properties: {
              file_key: {
                type: 'string',
                description: 'Figma file key'
              }
            },
            required: ['file_key']
          }
        },
        {
          name: 'get_file_nodes',
          description: 'Get specific nodes from a Figma file. IMPORTANT: Pagination (pageSize/cursor) ONLY works when fetching a SINGLE node - it paginates through that node\'s children. When fetching multiple nodes, pagination parameters are ignored. For large nodes use: pageSize: 10-25, summarizeNodes: true, depth: 1.',
          inputSchema: {
            type: 'object',
            properties: {
              file_key: {
                type: 'string',
                description: 'Figma file key'
              },
              ids: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: 'Array of node IDs to retrieve'
              },
              pageSize: {
                type: 'number',
                description: '[SINGLE NODE ONLY] Number of child nodes to fetch per page. Ignored when fetching multiple nodes.',
                minimum: 1,
                maximum: 1000
              },
              maxResponseSize: {
                type: 'number',
                description: 'Maximum response size in MB (defaults to 50)',
                minimum: 1,
                maximum: 100
              },
              cursor: {
                type: 'string',
                description: '[SINGLE NODE ONLY] Pagination cursor - child index to start from (e.g., "0", "50", "100"). Ignored when fetching multiple nodes.'
              },
              depth: {
                type: 'number',
                description: 'Maximum depth to traverse in the node tree',
                minimum: 1
              },
              nodeTypes: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: [
                    'FRAME',
                    'GROUP',
                    'VECTOR',
                    'BOOLEAN_OPERATION',
                    'STAR',
                    'LINE',
                    'TEXT',
                    'COMPONENT',
                    'INSTANCE'
                  ]
                },
                description: 'Filter nodes by type. For single nodes: filters children only (parent always kept). For multiple nodes: filters all requested nodes.'
              },
              excludeProps: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: 'Properties to exclude from node data'
              },
              summarizeNodes: {
                type: 'boolean',
                description: 'Return only essential node properties to reduce response size'
              }
            },
            required: ['file_key', 'ids']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error('[MCP Debug] Request', {
        tool: request.params.name,
        arguments: request.params.arguments,
      });

      try {
        switch (request.params.name) {
          case 'get_file_data': {
            const args = request.params.arguments as unknown as GetFileDataArgs;
            if (!args.file_key) {
              throw new McpError(ErrorCode.InvalidParams, 'file_key is required');
            }

            console.error('[MCP Debug] Fetching file data with chunking', {
              fileKey: args.file_key,
              pageSize: args.pageSize,
              maxMemoryMB: args.maxMemoryMB,
              nodeTypes: args.nodeTypes,
              maxResponseSize: args.maxResponseSize,
              excludeProps: args.excludeProps,
              summarizeNodes: args.summarizeNodes
            });

            const result = await this.figmaClient.getFileInfoChunked(
              args.file_key,
              args.cursor,
              args.depth,
              {
                pageSize: args.pageSize,
                maxMemoryMB: args.maxMemoryMB,
                nodeTypes: args.nodeTypes,
                maxResponseSize: args.maxResponseSize,
                excludeProps: args.excludeProps,
                summarizeNodes: args.summarizeNodes
              }
            );

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    nodes: result.nodes,
                    memoryUsage: result.memoryUsage,
                    nextCursor: result.nextCursor,
                    hasMore: result.hasMore
                  }, null, 2)
                }
              ]
            };
          }

          case 'list_files': {
            const args = request.params.arguments as unknown as ListFilesArgs;
            console.error('[MCP Debug] Listing files', args);
            const data = await this.figmaClient.listFiles(args);
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }

          case 'get_file_versions': {
            const args = request.params.arguments as unknown as FileKeyArgs;
            if (!args.file_key) {
              throw new McpError(ErrorCode.InvalidParams, 'file_key is required');
            }
            console.error('[MCP Debug] Fetching file versions', {
              fileKey: args.file_key,
            });
            const data = await this.figmaClient.getFileVersions(args.file_key);
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }

          case 'get_file_comments': {
            const args = request.params.arguments as unknown as FileKeyArgs;
            if (!args.file_key) {
              throw new McpError(ErrorCode.InvalidParams, 'file_key is required');
            }
            console.error('[MCP Debug] Fetching file comments', {
              fileKey: args.file_key,
            });
            const data = await this.figmaClient.getFileComments(args.file_key);
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }

          case 'get_components': {
            const args = request.params.arguments as unknown as FileKeyArgs;
            if (!args.file_key) {
              throw new McpError(ErrorCode.InvalidParams, 'file_key is required');
            }
            console.error('[MCP Debug] Fetching components', {
              fileKey: args.file_key,
            });
            const data = await this.figmaClient.getComponents(args.file_key);
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }

          case 'get_styles': {
            const args = request.params.arguments as unknown as FileKeyArgs;
            if (!args.file_key) {
              throw new McpError(ErrorCode.InvalidParams, 'file_key is required');
            }
            console.error('[MCP Debug] Fetching styles', {
              fileKey: args.file_key,
            });
            const data = await this.figmaClient.getStyles(args.file_key);
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }

          case 'get_file_nodes': {
            const args = request.params.arguments as unknown as FileNodesArgs & { 
              pageSize?: number;
              maxResponseSize?: number;
              cursor?: string;
              depth?: number;
              nodeTypes?: string[];
              excludeProps?: string[];
              summarizeNodes?: boolean;
            };
            if (!args.file_key) {
              throw new McpError(ErrorCode.InvalidParams, 'file_key is required');
            }
            if (!args.ids || !Array.isArray(args.ids) || args.ids.length === 0) {
              throw new McpError(
                ErrorCode.InvalidParams,
                'ids array is required and must not be empty'
              );
            }
            console.error('[MCP Debug] Fetching file nodes', args);
            const data = await this.figmaClient.getFileNodes(
              args.file_key, 
              args.ids, 
              {
                pageSize: args.pageSize,
                maxResponseSize: args.maxResponseSize,
                cursor: args.cursor,
                depth: args.depth,
                nodeTypes: args.nodeTypes,
                excludeProps: args.excludeProps,
                summarizeNodes: args.summarizeNodes
              }
            );
            
            // Check response size and provide helpful error if too large
            const jsonString = JSON.stringify(data, null, 2);
            const sizeInBytes = new TextEncoder().encode(jsonString).length;
            const estimatedTokens = Math.ceil(sizeInBytes / 4); // ~4 bytes per token
            
            if (estimatedTokens > 25000) {
              const helpfulError = {
                error: 'Response too large',
                estimatedTokens,
                maxTokens: 25000,
                currentParams: {
                  pageSize: args.pageSize || 50,
                  depth: args.depth || 'full',
                  summarizeNodes: args.summarizeNodes || false
                },
                solutions: [
                  '1. Use summarizeNodes: true to strip nodes to essentials',
                  '2. Reduce pageSize to 10-25 (fetches fewer children per request)',
                  '3. Set depth: 1 to fetch only immediate children',
                  '4. Add excludeProps: ["fills", "effects", "strokes", "exportSettings"]',
                  '5. Use cursor to paginate through children (cursor: "0" for first batch, "10" for second, etc.)'
                ],
                exampleCall: {
                  file_key: args.file_key,
                  ids: args.ids,
                  pageSize: 10,
                  depth: 1,
                  summarizeNodes: true,
                  excludeProps: ["fills", "effects", "strokes"],
                  cursor: "0"
                },
                nodeInfo: data.pagination || { note: 'Multiple nodes requested - try fetching one at a time' }
              };
              
              return {
                content: [{ type: 'text', text: JSON.stringify(helpfulError, null, 2) }],
              };
            }
            
            return {
              content: [{ type: 'text', text: jsonString }],
            };
          }

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error: any) {
        console.error('[MCP Error]', {
          tool: request.params.name,
          arguments: request.params.arguments,
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        });

        if (error instanceof McpError) {
          throw error;
        }
        return {
          content: [
            {
              type: 'text',
              text: `Figma API error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[MCP Debug] Figma MCP server running on stdio');
  }
}

const server = new FigmaMCPServer();
server.run().catch((error) => {
  console.error('[MCP Fatal Error]', {
    name: error.name,
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
