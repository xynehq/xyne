import React, { useState } from "react"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Label } from "./ui/label"
import { Textarea } from "./ui/textarea"
import { GraphNode, GraphEdge } from "../types/graph"

interface AddEdgeFormProps {
  nodes: GraphNode[]
  onEdgeAdd: (edge: Omit<GraphEdge, "id">) => void
  onCancel: () => void
  preSelectedFromNode?: string
  preSelectedToNode?: string
}

export const AddEdgeForm: React.FC<AddEdgeFormProps> = ({
  nodes,
  onEdgeAdd,
  onCancel,
  preSelectedFromNode,
  preSelectedToNode,
}) => {
  const [formData, setFormData] = useState({
    from: preSelectedFromNode || "",
    to: preSelectedToNode || "",
    relationship: "",
    weight: "1.0",
    metadata: "{}",
  })

  const [isValid, setIsValid] = useState(false)

  const handleInputChange = (field: string, value: string) => {
    const newData = { ...formData, [field]: value }
    setFormData(newData)
    setIsValid(
      newData.from !== "" &&
        newData.to !== "" &&
        newData.from !== newData.to &&
        newData.relationship.trim() !== "",
    )
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid) return

    try {
      const metadata = formData.metadata.trim()
        ? JSON.parse(formData.metadata)
        : {}
      const weight = parseFloat(formData.weight) || 1.0

      onEdgeAdd({
        from: formData.from,
        to: formData.to,
        relationship: formData.relationship.trim(),
        weight,
        metadata,
      })

      // Reset form
      setFormData({
        from: "",
        to: "",
        relationship: "",
        weight: "1.0",
        metadata: "{}",
      })
    } catch (error) {
      alert("Invalid JSON in metadata field or invalid weight value")
    }
  }

  const availableNodes = nodes.filter((node) => node.id !== formData.from)
  const fromNodes = nodes

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 shadow-lg">
      <h3 className="text-sm font-semibold mb-3">Add Directed Edge</h3>
      <div className="text-xs text-gray-600 dark:text-gray-400 mb-3">
        Create a directed relationship: Source → Target
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <Label htmlFor="from" className="text-sm">
            Source Node (From) *
          </Label>
          <select
            id="from"
            value={formData.from}
            onChange={(e) => handleInputChange("from", e.target.value)}
            className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            required
          >
            <option value="">Select source node...</option>
            {fromNodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name} ({node.type})
              </option>
            ))}
          </select>
        </div>

        <div>
          <Label htmlFor="to" className="text-sm">
            Target Node (To) *
          </Label>
          <select
            id="to"
            value={formData.to}
            onChange={(e) => handleInputChange("to", e.target.value)}
            className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            required
          >
            <option value="">Select target node...</option>
            {availableNodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name} ({node.type})
              </option>
            ))}
          </select>
        </div>

        <div>
          <Label htmlFor="relationship" className="text-sm">
            Relationship Type *
          </Label>
          <Input
            id="relationship"
            value={formData.relationship}
            onChange={(e) => handleInputChange("relationship", e.target.value)}
            placeholder="e.g., CONTAINS, RELATES_TO, CREATED_BY"
            required
            className="h-8 text-sm px-3"
          />
          <div className="text-xs text-gray-500 mt-1">
            Direction:{" "}
            {formData.from &&
            formData.to &&
            nodes.find((n: GraphNode) => n.id === formData.from)?.name &&
            nodes.find((n: GraphNode) => n.id === formData.to)?.name
              ? `${nodes.find((n: GraphNode) => n.id === formData.from)?.name} → ${nodes.find((n: GraphNode) => n.id === formData.to)?.name}`
              : "Select nodes to see direction"}
          </div>
        </div>

        <div>
          <Label htmlFor="weight" className="text-sm">
            Weight
          </Label>
          <Input
            id="weight"
            type="number"
            step="0.1"
            min="0"
            max="10"
            value={formData.weight}
            onChange={(e) => handleInputChange("weight", e.target.value)}
            placeholder="1.0"
            className="h-8 text-sm px-3"
          />
        </div>

        <div>
          <Label htmlFor="metadata" className="text-sm">
            Metadata (JSON)
          </Label>
          <Textarea
            id="metadata"
            value={formData.metadata}
            onChange={(e) => handleInputChange("metadata", e.target.value)}
            placeholder='{"key": "value"}'
            rows={2}
            className="text-sm px-3 py-2"
          />
        </div>

        <div className="flex gap-2 pt-2">
          <Button
            type="submit"
            disabled={!isValid}
            className="flex-1 h-8 text-sm"
          >
            ✅ Create Edge
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            className="flex-1 h-8 text-sm"
          >
            ❌ Cancel
          </Button>
        </div>
      </form>

      {formData.from && formData.to && formData.from === formData.to && (
        <div className="mt-2 text-xs text-red-600 dark:text-red-400">
          ⚠️ Source and target nodes must be different
        </div>
      )}
    </div>
  )
}
