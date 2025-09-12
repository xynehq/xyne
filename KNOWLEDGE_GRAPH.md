# Knowledge Graph Feature

## Overview

The Knowledge Graph is a powerful visualization and management system that represents relationships between different entities in your workspace. It combines file system data with custom user-created nodes and relationships to provide a comprehensive view of your knowledge base.

## Features

### 🎯 Directed Relationships
- All edges show clear directional arrows indicating the flow of relationships
- Source → Target relationships with visual arrow indicators
- Hover effects highlight edges and arrows for better interaction

### 🏗️ Hierarchical Node System
The knowledge graph uses a structured hierarchy with nodes positioned spatially based on their importance:

**Node Types & Hierarchy** (from top to bottom):
1. **Seed** (26px) - `#E63946` - Top-level concepts and starting points
2. **Concept** (22px) - `#457B9D` - Abstract ideas and conceptual frameworks
3. **Entity** (20px) - `#1D3557` - General entities and objects
4. **Person** (18px) - `#F4A261` - Individual people
5. **Company** (18px) - `#2A9D8F` - Organizations and companies
6. **Project** (18px) - `#E9C46A` - Projects and initiatives
7. **Tool** (18px) - `#8D99AE` - Software tools and utilities
8. **Event** (18px) - `#F77F00` - Events and occurrences
9. **Document** (16px) - `#6D597A` - Documents and files
10. **Folder** (14px) - `#B5838D` - File system folders
11. **File** (14px) - `#A8DADC` - Individual files
12. **Collection** (14px) - `#90A955` - Knowledge base collections
13. **Relation** (12px) - `#ec4899` - Relationship indicators

### 🎨 Visual Design
- **Clean Interface**: No emoji clutter, professional color-coded nodes
- **Spatial Hierarchy**: Larger, more important nodes appear higher in the visualization
- **Responsive Sizing**: Node sizes reflect their importance in the system
- **Theme Support**: Adapts to both light and dark themes

### 🔧 Interactive Features
- **Drag & Drop**: Move nodes around to customize layout
- **Zoom & Pan**: Navigate large graphs with smooth zoom controls
- **Node Selection**: Click nodes to select and highlight them
- **Edge Interaction**: Click edges to view relationship details
- **Layout Controls**: Reset zoom and restart physics simulation

## Technical Implementation

### Database Layer (KuzuDB)
- **Graph Database**: Uses KuzuDB for efficient graph storage and querying
- **Directed Edges**: Native support for directional relationships
- **Schema**: 
  - `GraphNode` table with properties (id, name, type, position, metadata, etc.)
  - `CONNECTS` relationship table with edge properties
- **Workspace Isolation**: All data is scoped to user workspaces

### Backend API
**Endpoints:**
- `GET /api/knowledge-graph` - Retrieve complete graph data
- `POST /api/knowledge-graph/nodes` - Create new custom nodes
- `POST /api/knowledge-graph/edges` - Create new relationships
- `DELETE /api/knowledge-graph/nodes/:id` - Remove nodes
- `DELETE /api/knowledge-graph/edges/:id` - Remove edges
- `GET /api/knowledge-graph/nodes/:id` - Get node details
- `POST /api/knowledge-graph/clear` - Clear all custom graph data

### Frontend Components
- **GraphVisualization**: D3.js-powered interactive visualization
- **AddNodeForm**: Interface for creating custom nodes
- **AddEdgeForm**: Interface for creating relationships
- **KnowledgeGraph**: Main container component

### Physics Simulation
- **D3.js Forces**:
  - **Link Force**: Connects related nodes with appropriate distance
  - **Charge Force**: Repulsion between nodes to prevent overlap
  - **Center Force**: Keeps graph centered in viewport
  - **Collision Force**: Prevents node overlapping based on actual sizes
  - **Hierarchy Force**: Custom force that positions larger nodes higher

## Data Sources

### Hybrid Approach
The knowledge graph combines multiple data sources:

1. **File System Data**: Automatically creates nodes for:
   - Collections from your knowledge base
   - Folders and files from uploaded content
   - Hierarchical relationships between folders/files

2. **Custom User Data**: Manually created:
   - Concept nodes for abstract ideas
   - Person/Company nodes for entities
   - Project nodes for initiatives
   - Custom relationships between any nodes

3. **Automatic Relationships**: System-generated:
   - Parent-child relationships (folder → file)
   - Content type categorization
   - Collection similarity matching

## Usage Guide

### Creating Custom Nodes
1. Click "Add Node" in the knowledge graph interface
2. Enter node name and description
3. Select appropriate node type from hierarchy
4. Optionally set initial position
5. Save to persist in database

### Creating Relationships
1. Click "Add Edge" in the knowledge graph interface
2. Select source node (from)
3. Select target node (to)
4. Define relationship type/label
5. Set optional weight and metadata
6. Save to create directed edge

### Navigation
- **Mouse Wheel**: Zoom in/out
- **Click & Drag**: Pan the viewport
- **Node Drag**: Reposition individual nodes
- **🎯 Button**: Reset zoom to fit all nodes
- **🔄 Button**: Restart physics simulation

## API Response Format

### Graph Data Structure
```json
{
  "nodes": [
    {
      "id": "node_123",
      "name": "Example Node",
      "description": "Node description",
      "type": "concept",
      "metadata": {},
      "x": 100,
      "y": 200,
      "size": 22,
      "color": "#457B9D"
    }
  ],
  "edges": [
    {
      "id": "edge_456",
      "from": "node_123",
      "to": "node_789",
      "relationship": "relates_to",
      "weight": 1.0,
      "metadata": {}
    }
  ]
}
```

## Database Schema

### GraphNode Table
```sql
CREATE NODE TABLE GraphNode(
    id STRING,
    workspace_id STRING,
    name STRING,
    description STRING,
    node_type STRING,
    position_x DOUBLE,
    position_y DOUBLE,
    size INT64,
    color STRING,
    metadata STRING,
    created_by STRING,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    source STRING,
    PRIMARY KEY (id)
)
```

### CONNECTS Relationship Table
```sql
CREATE REL TABLE CONNECTS(
    FROM GraphNode TO GraphNode,
    edge_id STRING,
    workspace_id STRING,
    relationship_type STRING,
    weight DOUBLE,
    metadata STRING,
    created_by STRING,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
)
```

## Performance Considerations

- **Efficient Querying**: KuzuDB optimized for graph traversals
- **Workspace Scoping**: All queries filtered by workspace for isolation
- **Lazy Loading**: Large graphs load incrementally
- **Physics Optimization**: Simulation forces tuned for performance
- **Memory Management**: D3.js simulation cleaned up on component unmount

## Future Enhancements

- **Graph Analytics**: Centrality measures, clustering coefficients
- **Advanced Filtering**: Filter by node type, relationship type, date ranges
- **Export/Import**: JSON/GraphML export for external tools
- **Collaborative Editing**: Real-time multi-user graph editing
- **AI Integration**: Automatic relationship suggestions based on content analysis
- **Search & Discovery**: Graph-based search with path finding
- **Version History**: Track changes to graph structure over time

## Troubleshooting

### Common Issues
1. **Nodes Not Appearing**: Check KuzuDB connection and workspace ID
2. **Physics Simulation Stuck**: Use restart layout button (🔄)
3. **Performance Issues**: Reduce node count or optimize force parameters
4. **TypeScript Errors**: Ensure all node types are properly defined

### Debug Information
- Browser console shows D3.js simulation status
- Server logs include KuzuDB operation results
- Network tab shows API call success/failure

---

*The Knowledge Graph provides a powerful way to visualize and explore the relationships within your workspace, combining automatic file system analysis with manual knowledge structuring capabilities.*
