import React, { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { GraphNode, NodeType, NODE_TYPE_CONFIG } from '../types/graph';

interface AddNodeFormProps {
  onNodeAdd: (node: Omit<GraphNode, 'id'>) => void;
  onCancel: () => void;
}

export const AddNodeForm: React.FC<AddNodeFormProps> = ({ onNodeAdd, onCancel }) => {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    type: 'concept' as NodeType,
    metadata: '{}'
  });

  const [isValid, setIsValid] = useState(false);

  const handleInputChange = (field: string, value: string) => {
    const newData = { ...formData, [field]: value };
    setFormData(newData);
    setIsValid(newData.name.trim() !== '' && newData.description.trim() !== '');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    try {
      const metadata = formData.metadata.trim() ? JSON.parse(formData.metadata) : {};
      
      onNodeAdd({
        name: formData.name.trim(),
        description: formData.description.trim(),
        type: formData.type,
        metadata
      });

      // Reset form
      setFormData({
        name: '',
        description: '',
        type: 'Topic',
        metadata: '{}'
      });
    } catch (error) {
      alert('Invalid JSON in metadata field');
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 shadow-lg">
      <h3 className="text-sm font-semibold mb-3">Add New Node</h3>
      
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <Label htmlFor="name" className="text-sm">Name *</Label>
          <Input
            id="name"
            value={formData.name}
            onChange={(e) => handleInputChange('name', e.target.value)}
            placeholder="Node name"
            required
            className="h-8 text-sm px-3"
          />
        </div>

        <div>
          <Label htmlFor="description" className="text-sm">Description *</Label>
          <Textarea
            id="description"
            value={formData.description}
            onChange={(e) => handleInputChange('description', e.target.value)}
            placeholder="Description"
            rows={3}
            required
            className="text-sm px-3 py-2"
          />
        </div>

        <div>
          <Label htmlFor="type" className="text-sm">Type</Label>
          <select
            id="type"
            value={formData.type}
            onChange={(e) => handleInputChange('type', e.target.value)}
            className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {Object.entries(NODE_TYPE_CONFIG).map(([type, config]) => (
              <option key={type} value={type}>
                {config.icon} {config.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <Label htmlFor="metadata" className="text-sm">Metadata (JSON)</Label>
          <Textarea
            id="metadata"
            value={formData.metadata}
            onChange={(e) => handleInputChange('metadata', e.target.value)}
            placeholder='{"key": "value"}'
            rows={2}
            className="text-sm px-3 py-2"
          />
        </div>

        <div className="flex gap-2 pt-2">
          <Button type="submit" disabled={!isValid} className="flex-1 h-8 text-sm">
            ✅ Create
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} className="flex-1 h-8 text-sm">
            ❌ Cancel
          </Button>
        </div>
      </form>
    </div>
  );
};
