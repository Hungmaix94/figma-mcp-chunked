import axios, { AxiosInstance } from 'axios';
import type { DocumentNode, SceneNode } from './types.js';

interface ChunkConfig {
  pageSize: number;
  maxMemoryMB: number;
  nodeTypes?: string[];
  maxDepth?: number;
  excludeProps?: string[];
  maxResponseSize?: number; // in MB
  summarizeNodes?: boolean;
}

class StreamingNodeProcessor {
  private processedNodes: Set<string>;
  private config: ChunkConfig;
  private currentSize: number;

  constructor(config: ChunkConfig) {
    this.processedNodes = new Set();
    this.config = config;
    this.currentSize = 0;
  }

  private estimateNodeSize(node: SceneNode): number {
    return Buffer.byteLength(JSON.stringify(node)) / 1024 / 1024; // Size in MB
  }

  public filterNodeProperties(node: SceneNode, excludeProps?: string[]): SceneNode {
    const propsToExclude = excludeProps || this.config.excludeProps || [];
    if (!propsToExclude.length) return node;

    const filteredNode = { ...node };
    for (const prop of propsToExclude) {
      if (prop !== 'id' && prop !== 'type') { // Preserve required properties
        delete (filteredNode as any)[prop];
      }
    }
    return filteredNode;
  }

  public summarizeNode(node: SceneNode): SceneNode {
    // Create a type-safe base object
    const base: Pick<SceneNode, 'id' | 'name' | 'visible'> & { type: SceneNode['type'] } = {
      id: node.id,
      name: node.name || '',
      visible: node.visible ?? true,
      type: node.type,
    };

    // Add type-specific required properties
    switch (node.type as SceneNode['type']) {
      case 'FRAME':
        return {
          ...base,
          type: 'FRAME' as const,
          children: 'children' in node ? node.children : [],
          background: [],
        };
      case 'GROUP':
        return {
          ...base,
          type: 'GROUP' as const,
          children: 'children' in node ? node.children : [],
        };
      case 'VECTOR':
        return {
          ...base,
          type: 'VECTOR' as const,
        };
      case 'BOOLEAN_OPERATION':
        return {
          ...base,
          type: 'BOOLEAN_OPERATION' as const,
          children: 'children' in node ? node.children : [],
          booleanOperation: 'UNION',
        };
      case 'STAR':
        return {
          ...base,
          type: 'STAR' as const,
          pointCount: 5,
          innerRadius: 0.5,
        };
      case 'LINE':
        return {
          ...base,
          type: 'LINE' as const,
        };
      case 'TEXT':
        return {
          ...base,
          type: 'TEXT' as const,
          characters: 'characters' in node ? node.characters : '',
          style: {
            fontFamily: 'Inter',
            fontWeight: 400,
            fontSize: 16,
            textAlignHorizontal: 'LEFT',
            letterSpacing: 0,
            lineHeightUnit: 'PIXELS',
          },
        };
      case 'COMPONENT':
        return {
          ...base,
          type: 'COMPONENT' as const,
          children: 'children' in node ? node.children : [],
          componentId: 'componentId' in node ? node.componentId : '',
        };
      case 'INSTANCE':
        return {
          ...base,
          type: 'INSTANCE' as const,
          children: 'children' in node ? node.children : [],
          componentId: 'componentId' in node ? node.componentId : '',
        };
      case 'CANVAS':
        return {
          ...base,
          type: 'CANVAS' as const,
          children: 'children' in node ? node.children : [],
          backgroundColor: { r: 1, g: 1, b: 1, a: 1 }
        };
      default:
        // Instead of throwing error, return base node with minimal properties
        return {
          ...base,
          children: 'children' in node ? node.children : []
        } as SceneNode;
    }
  }

  shouldProcessNode(node: SceneNode, depth: number): boolean {
    if (this.processedNodes.has(node.id)) return false;
    if (this.config.nodeTypes && !this.config.nodeTypes.includes(node.type)) return false;
    if (this.config.maxDepth !== undefined && depth > this.config.maxDepth) return false;
    
    const nodeSize = this.estimateNodeSize(node);
    if (this.currentSize + nodeSize > (this.config.maxResponseSize || this.config.maxMemoryMB)) {
      return false;
    }

    return true;
  }

  processNode(node: SceneNode, depth: number): SceneNode | null {
    if (!this.shouldProcessNode(node, depth)) return null;

    this.processedNodes.add(node.id);
    let processedNode = this.filterNodeProperties(node);
    
    if (this.config.summarizeNodes) {
      processedNode = this.summarizeNode(processedNode);
    }

    this.currentSize += this.estimateNodeSize(processedNode);
    return processedNode;
  }

  hasReachedLimit(): boolean {
    return this.currentSize >= (this.config.maxResponseSize || this.config.maxMemoryMB);
  }

  getCurrentSize(): number {
    return this.currentSize;
  }

  getProcessedCount(): number {
    return this.processedNodes.size;
  }
}

interface ChunkResult {
  nodes: SceneNode[];
  memoryUsage: number;
  nextCursor?: string;
  hasMore: boolean;
}

export class ChunkedFigmaClient {
  private client: AxiosInstance;
  private config: ChunkConfig;
  private nodeProcessor: StreamingNodeProcessor;

  constructor(accessToken: string, config: Partial<ChunkConfig> = {}) {
    this.client = axios.create({
      baseURL: 'https://api.figma.com/v1',
      headers: {
        'X-Figma-Token': accessToken,
      },
    });

    this.config = {
      pageSize: config.pageSize || 100,
      maxMemoryMB: config.maxMemoryMB || 512,
      nodeTypes: config.nodeTypes,
      maxDepth: config.maxDepth,
      excludeProps: config.excludeProps,
      maxResponseSize: config.maxResponseSize || 50, // Default 50MB response size
      summarizeNodes: config.summarizeNodes,
    };

    this.nodeProcessor = new StreamingNodeProcessor(this.config);
  }

  private async streamNodes(
    document: DocumentNode,
    cursor?: string
  ): Promise<ChunkResult> {
    const result: SceneNode[] = [];
    const queue: Array<{ node: SceneNode; depth: number }> = document.children.map(node => ({ node, depth: 0 }));
    let currentIndex = cursor ? parseInt(cursor, 10) : 0;

    // Skip to cursor position
    while (currentIndex > 0 && queue.length > 0) {
      queue.shift();
      currentIndex--;
    }

    while (queue.length > 0 && result.length < this.config.pageSize) {
      const { node, depth } = queue.shift()!;
      
      const processedNode = this.nodeProcessor.processNode(node, depth);
      if (processedNode) {
        result.push(processedNode as SceneNode);
      }

      if ('children' in node) {
        queue.unshift(...node.children.map(child => ({ 
          node: child, 
          depth: depth + 1 
        })));
      }

      if (this.nodeProcessor.hasReachedLimit()) {
        break;
      }
    }

    return {
      nodes: result,
      memoryUsage: this.nodeProcessor.getCurrentSize(),
      nextCursor: queue.length > 0 ? this.nodeProcessor.getProcessedCount().toString() : undefined,
      hasMore: queue.length > 0
    };
  }

  async getFileInfoChunked(
    fileKey: string,
    cursor?: string,
    depth?: number,
    config?: Partial<ChunkConfig>
  ): Promise<ChunkResult> {
    // Update config with new options
    if (config) {
      this.config = {
        ...this.config,
        ...config
      };
      // Recreate node processor with new config
      this.nodeProcessor = new StreamingNodeProcessor(this.config);
    }
    try {
      const response = await this.client.get(`/files/${fileKey}`, {
        params: { depth: depth || this.config.maxDepth },
      });

      if (!response.data || !response.data.document) {
        throw new Error('Invalid response from Figma API');
      }

      return this.streamNodes(response.data.document, cursor);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Figma API error: ${error.response?.data?.message || error.message}`);
      }
      throw error;
    }
  }

  async listFiles(params: { project_id?: string; team_id?: string }) {
    try {
      console.error('[MCP Debug] Listing files with params:', params);
      const response = await this.client.get('/files', { params });
      return response.data;
    } catch (error) {
      console.error('[MCP Error] Failed to list files:', error);
      throw error;
    }
  }

  async getComponents(fileKey: string) {
    try {
      console.error('[MCP Debug] Getting components for file:', fileKey);
      const response = await this.client.get(`/files/${fileKey}/components`);
      
      if (this.nodeProcessor.hasReachedLimit()) {
        console.error('[MCP Debug] Memory limit reached while processing components');
        throw new Error('Memory limit exceeded while processing components');
      }

      return response.data;
    } catch (error) {
      console.error('[MCP Error] Failed to get components:', error);
      throw error;
    }
  }

  async getStyles(fileKey: string) {
    try {
      console.error('[MCP Debug] Getting styles for file:', fileKey);
      const response = await this.client.get(`/files/${fileKey}/styles`);
      
      if (this.nodeProcessor.hasReachedLimit()) {
        console.error('[MCP Debug] Memory limit reached while processing styles');
        throw new Error('Memory limit exceeded while processing styles');
      }

      return response.data;
    } catch (error) {
      console.error('[MCP Error] Failed to get styles:', error);
      throw error;
    }
  }

  async getFileVersions(fileKey: string) {
    try {
      console.error('[MCP Debug] Getting versions for file:', fileKey);
      const response = await this.client.get(`/files/${fileKey}/versions`);
      
      if (this.nodeProcessor.hasReachedLimit()) {
        console.error('[MCP Debug] Memory limit reached while processing versions');
        throw new Error('Memory limit exceeded while processing versions');
      }

      return response.data;
    } catch (error) {
      console.error('[MCP Error] Failed to get file versions:', error);
      throw error;
    }
  }

  async getFileComments(fileKey: string) {
    try {
      console.error('[MCP Debug] Getting comments for file:', fileKey);
      const response = await this.client.get(`/files/${fileKey}/comments`);
      
      if (this.nodeProcessor.hasReachedLimit()) {
        console.error('[MCP Debug] Memory limit reached while processing comments');
        throw new Error('Memory limit exceeded while processing comments');
      }

      return response.data;
    } catch (error) {
      console.error('[MCP Error] Failed to get file comments:', error);
      throw error;
    }
  }


  /**
   * Fetches specific nodes from a Figma file by their IDs.
   * 
   * For single node requests:
   * - Implements pagination through the node's children
   * - First fetches parent with depth=1 to get child list
   * - Then fetches paginated children with requested depth
   * 
   * For multiple node requests:
   * - Fetches all requested nodes at once
   * - No pagination (returns all nodes)
   * 
   * @param fileKey - Figma file key
   * @param ids - Array of node IDs to fetch
   * @param options.pageSize - Number of children to fetch per page (single node only)
   * @param options.cursor - Pagination cursor (child index to start from)
   * @param options.depth - How deep to fetch children (default: 2)
   * @param options.nodeTypes - Filter children by type (parent always kept)
   * @param options.excludeProps - Properties to exclude from all nodes
   * @param options.summarizeNodes - Return minimal node data
   * @param options.maxResponseSize - Max response size in MB (warning only)
   */
  async getFileNodes(fileKey: string, ids: string[], options: {
    pageSize?: number;
    maxResponseSize?: number;
    cursor?: string;
    depth?: number;
    nodeTypes?: string[];
    excludeProps?: string[];
    summarizeNodes?: boolean;
  } = {}) {
    try {
      // Input validation
      if (!fileKey || typeof fileKey !== 'string' || fileKey.trim() === '') {
        throw new Error('fileKey must be a non-empty string');
      }
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        throw new Error('ids must be a non-empty array');
      }
      
      // Basic ID validation - Figma API will handle the rest
      for (const id of ids) {
        if (!id || typeof id !== 'string') {
          throw new Error('All node IDs must be non-empty strings');
        }
      }
      
      if (process.env.MCP_DEBUG) {
        console.error('[MCP Debug] Getting nodes for file:', fileKey, 'Options:', options);
      }
      
      const {
        pageSize = 50,
        maxResponseSize = 50,
        cursor,
        depth = 2,
        nodeTypes,
        excludeProps,
        summarizeNodes = false
      } = options;
      
      // Validate options
      if (pageSize !== undefined) {
        if (typeof pageSize !== 'number' || pageSize < 1 || pageSize > 1000) {
          throw new Error('pageSize must be between 1 and 1000');
        }
      }
      
      if (depth !== undefined) {
        if (typeof depth !== 'number' || depth < 0 || depth > 10) {
          throw new Error('depth must be between 0 and 10');
        }
      }
      
      if (maxResponseSize !== undefined) {
        if (typeof maxResponseSize !== 'number' || maxResponseSize < 1 || maxResponseSize > 100) {
          throw new Error('maxResponseSize must be between 1 and 100 MB');
        }
      }
      
      if (excludeProps && excludeProps.length > 0) {
        const criticalProps = ['id', 'type', 'name'];
        for (const prop of excludeProps) {
          if (criticalProps.includes(prop)) {
            throw new Error(`Cannot exclude critical property: ${prop}`);
          }
        }
      }
      

      // For single node requests, implement child pagination
      if (ids.length === 1) {
        const nodeId = ids[0];
        
        // Step 1: Fetch the parent node with depth=1 to get immediate children list
        // We always fetch parent with depth=1 first for pagination to work
        let shallowResponse;
        try {
          shallowResponse = await this.client.get(`/files/${fileKey}/nodes`, {
            params: { 
              ids: nodeId,
              depth: 1 // Shallow fetch to get list of immediate children IDs
            }
          });
        } catch (error: any) {
          if (error.response?.status === 413 || error.response?.status === 504) {
            throw new Error(
              `Node is too large to fetch all at once. ` +
              `Try these parameters to paginate through its children:\n` +
              `- pageSize: 10 (fetch 10 children at a time)\n` +
              `- cursor: "0" (start from first child)\n` +
              `- depth: 1 (immediate children only)\n` +
              `- summarizeNodes: true (minimal data)\n` +
              `- excludeProps: ["fills", "effects", "strokes"] (remove heavy properties)`
            );
          }
          throw error;
        }
        
        if (!shallowResponse.data || !shallowResponse.data.nodes) {
          throw new Error('Invalid response from Figma API');
        }
        
        let mainNode = shallowResponse.data.nodes[nodeId];
        if (!mainNode) {
          throw new Error('Requested node not found');
        }
        
        // Handle Figma's document wrapper - sometimes nodes come wrapped in a 'document' object
        // Clone to avoid mutations
        const actualNode = { ...(mainNode.document || mainNode) };
        
        // Step 2: Extract children IDs (safely)
        const allChildIds: string[] = [];
        if (actualNode.children) {
          if (!Array.isArray(actualNode.children)) {
            console.warn('[MCP Warning] Node children property is not an array');
          } else {
            for (const child of actualNode.children) {
              if (child && typeof child === 'object' && child.id && typeof child.id === 'string') {
                allChildIds.push(child.id);
              }
            }
          }
        }
        
        if (process.env.MCP_DEBUG) {
          console.error(`[MCP Debug] Found ${allChildIds.length} children`);
        }
        
        // Step 3: Paginate through children
        const startIndex = cursor ? parseInt(cursor, 10) : 0;
        if (isNaN(startIndex) || startIndex < 0) {
          throw new Error(`Invalid cursor value: ${cursor}. Must be a non-negative number.`);
        }
        if (startIndex >= allChildIds.length) {
          // Cursor is beyond the last child - return empty result with hasMore=false
          return {
            nodes: { [nodeId]: actualNode },
            pagination: {
              totalChildren: allChildIds.length,
              fetchedChildren: 0,
              nextCursor: undefined,
              hasMore: false,
              message: allChildIds.length === 0 
                ? 'Node has no children' 
                : `Cursor beyond range (max: ${allChildIds.length - 1})`
            }
          };
        }
        const safePageSize = pageSize; // Already validated above
        const endIndex = Math.min(startIndex + safePageSize, allChildIds.length);
        const childIdsToFetch = allChildIds.slice(startIndex, endIndex);
        
        let childrenData: any = {};
        
        // Step 4: Fetch the selected page of children (if any)
        if (childIdsToFetch.length > 0) {
          const childParams: any = { 
            ids: childIdsToFetch.join(',')
          };
          // Apply depth to children fetch (depth applies to how deep we fetch each child)
          // depth=1 means fetch children with their immediate children
          // depth=2 means fetch children with 2 levels of descendants, etc.
          if (typeof depth === 'number' && depth >= 0) {
            childParams.depth = depth;
          }
          
          let childResponse;
          try {
            childResponse = await this.client.get(`/files/${fileKey}/nodes`, {
              params: childParams,
              timeout: 30000 // 30 second timeout
            });
          } catch (childError: any) {
            console.error('[MCP Error] Failed to fetch children:', childError.message);
            // Return partial result with parent only
            return {
              nodes: { [nodeId]: actualNode },
              pagination: {
                totalChildren: allChildIds.length,
                fetchedChildren: 0,
                nextCursor: startIndex.toString(),
                hasMore: true,
                error: 'Failed to fetch children, returning parent only'
              }
            };
          }
          
          if (!childResponse.data || !childResponse.data.nodes) {
            console.warn('[MCP Warning] Invalid response for child nodes, using empty object');
            childrenData = {};
          } else {
            childrenData = childResponse.data.nodes;
          }
          
          // Handle document wrapper for children too
          for (const [childId, childNode] of Object.entries(childrenData)) {
            if ((childNode as any).document) {
              childrenData[childId] = (childNode as any).document;
            }
          }
        }
        
        // Step 5: Combine parent and children nodes
        // Note: We don't modify the parent's children array - it shows all children IDs
        // The fetched children are separate entries in the nodes object
        let processedData: any = {
          [nodeId]: actualNode, // Parent node (already has full children array from depth=1 fetch)
          ...childrenData       // Fetched children (based on pagination)
        };
        
        // Filter by node types if specified
        // Note: Parent node is always kept regardless of its type (for context)
        if (nodeTypes && nodeTypes.length > 0) {
          const filteredData: any = {
            [nodeId]: processedData[nodeId] // Always keep parent for context
          };
          for (const [id, node] of Object.entries(processedData)) {
            if (id !== nodeId) {
              const nodeType = (node as any).type;
              if (nodeType && nodeTypes.includes(nodeType)) {
                filteredData[id] = node;
              }
            }
          }
          processedData = filteredData;
        }
        
        // Exclude properties if specified
        if (excludeProps && excludeProps.length > 0) {
          const cleanedData: any = {};
          for (const [id, node] of Object.entries(processedData)) {
            cleanedData[id] = this.nodeProcessor.filterNodeProperties(node as SceneNode, excludeProps);
          }
          processedData = cleanedData;
        }
        
        // Apply summarization if requested
        if (summarizeNodes) {
          const summarizedData: any = {};
          for (const [id, node] of Object.entries(processedData)) {
            summarizedData[id] = this.nodeProcessor.summarizeNode(node as SceneNode);
          }
          processedData = summarizedData;
        }
        
        // Check response size (with safety for large objects)
        let responseSize = 0;
        try {
          responseSize = JSON.stringify(processedData).length / (1024 * 1024); // in MB
          if (responseSize > maxResponseSize) {
            console.warn(`[MCP Warning] Response size ${responseSize.toFixed(2)}MB exceeds max ${maxResponseSize}MB`);
          }
        } catch (e) {
          console.warn('[MCP Warning] Response too large to calculate size');
        }
        
        return {
          nodes: processedData,
          pagination: {
            totalChildren: allChildIds.length,
            fetchedChildren: childIdsToFetch.length,
            nextCursor: endIndex < allChildIds.length ? endIndex.toString() : undefined,
            hasMore: endIndex < allChildIds.length
          }
        };
      }
      
      // For multiple nodes, fetch them all at once (no child pagination)
      
      // Warn if pagination parameters are provided with multiple nodes
      if (cursor || (pageSize && pageSize !== 50)) {
        console.warn(
          '[MCP Warning] Pagination parameters (pageSize, cursor) are ignored when fetching multiple nodes. ' +
          'Pagination only works when fetching a single node (to paginate through its children).'
        );
      }
      
      const params: any = { ids: ids.join(',') };
      if (typeof depth === 'number') params.depth = depth;
      
      const response = await this.client.get(`/files/${fileKey}/nodes`, {
        params,
        timeout: 30000 // 30 second timeout
      });
      
      if (!response.data || !response.data.nodes) {
        throw new Error('Invalid response from Figma API');
      }
      
      let nodeData = response.data.nodes;
      
      // Handle document wrapper for multiple nodes
      for (const [id, node] of Object.entries(nodeData)) {
        if ((node as any).document) {
          nodeData[id] = (node as any).document;
        }
      }
      
      // Apply filters and transformations
      if (nodeTypes && nodeTypes.length > 0) {
        const filteredNodes: any = {};
        for (const [id, node] of Object.entries(nodeData)) {
          const nodeType = (node as any).type;
          if (nodeType && nodeTypes.includes(nodeType)) {
            filteredNodes[id] = node;
          }
        }
        nodeData = filteredNodes;
      }
      
      if (excludeProps && excludeProps.length > 0) {
        const processedNodes: any = {};
        for (const [id, node] of Object.entries(nodeData)) {
          processedNodes[id] = this.nodeProcessor.filterNodeProperties(node as SceneNode, excludeProps);
        }
        nodeData = processedNodes;
      }
      
      if (summarizeNodes) {
        const summarizedNodes: any = {};
        for (const [id, node] of Object.entries(nodeData)) {
          summarizedNodes[id] = this.nodeProcessor.summarizeNode(node as SceneNode);
        }
        nodeData = summarizedNodes;
      }
      
      // Return with clear indication that pagination doesn't apply
      const result: any = {
        nodes: nodeData
      };
      
      // Only include pagination info if user tried to use pagination params
      if (cursor || (pageSize && pageSize !== 50)) {
        result.pagination = {
          warning: 'Pagination parameters were ignored. Pagination only works when fetching a single node.',
          explanation: 'To paginate: fetch one node at a time, use pageSize and cursor to navigate through its children.'
        };
      }
      
      return result;
    } catch (error: any) {
      // Sanitize error messages
      const message = error.message || 'Unknown error';
      const sanitized = message.substring(0, 500); // Limit error message length
      console.error('[MCP Error] Failed to get file nodes:', sanitized);
      throw new Error(`Failed to get nodes: ${sanitized}`);
    }
  }
}
