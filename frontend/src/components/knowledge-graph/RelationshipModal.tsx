interface RelationshipModalProps {
  isOpen: boolean
  onClose: () => void
  relationship: any
  onEntitySelect: (entityName: string) => void
}

export function RelationshipModal({ isOpen, onClose, relationship, onEntitySelect }: RelationshipModalProps) {
  if (!isOpen || !relationship) return null

  const handleEntityClick = (entityName: string) => {
    onEntitySelect(entityName)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-xl font-semibold text-gray-900">
              Relationship Details
            </h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-2xl font-bold"
            >
              ×
            </button>
          </div>

          {/* Relationship Overview */}
          <div className="bg-gray-50 rounded-lg p-4 mb-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <button
                  onClick={() => handleEntityClick(relationship.source)}
                  className="bg-blue-100 text-blue-800 px-3 py-2 rounded-lg hover:bg-blue-200 transition-colors font-medium"
                >
                  {relationship.source}
                </button>
                <div className="text-gray-500">
                  <div className="text-sm font-medium">{relationship.type || relationship.label}</div>
                  <div className="text-xs">→</div>
                </div>
                <button
                  onClick={() => handleEntityClick(relationship.target)}
                  className="bg-green-100 text-green-800 px-3 py-2 rounded-lg hover:bg-green-200 transition-colors font-medium"
                >
                  {relationship.target}
                </button>
              </div>
            </div>
          </div>

          {/* Relationship Details */}
          <div className="space-y-4">
            <div>
              <h4 className="text-lg font-medium text-gray-900 mb-3">Relationship Information</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Relationship Type
                  </label>
                  <div className="bg-gray-50 p-3 rounded border">
                    {relationship.type || relationship.label || 'Unknown'}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Relationship ID
                  </label>
                  <div className="bg-gray-50 p-3 rounded border text-sm text-gray-600">
                    {relationship.id || 'N/A'}
                  </div>
                </div>
              </div>
            </div>

            {/* Source Entity Details */}
            <div>
              <h4 className="text-lg font-medium text-gray-900 mb-3">Source Entity</h4>
              <div className="bg-blue-50 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <h5 className="font-medium text-blue-900">{relationship.source}</h5>
                  <button
                    onClick={() => handleEntityClick(relationship.source)}
                    className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                  >
                    View Graph →
                  </button>
                </div>
                {relationship.details?.sourceEntity && (
                  <div className="space-y-2">
                    <div className="text-sm">
                      <span className="font-medium">Type:</span> {relationship.details.sourceEntity.type || 'Unknown'}
                    </div>
                    {relationship.details.sourceEntity.description && (
                      <div className="text-sm">
                        <span className="font-medium">Description:</span> {relationship.details.sourceEntity.description}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Target Entity Details */}
            <div>
              <h4 className="text-lg font-medium text-gray-900 mb-3">Target Entity</h4>
              <div className="bg-green-50 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <h5 className="font-medium text-green-900">{relationship.target}</h5>
                  <button
                    onClick={() => handleEntityClick(relationship.target)}
                    className="text-green-600 hover:text-green-800 text-sm font-medium"
                  >
                    View Graph →
                  </button>
                </div>
                {relationship.details?.targetEntity && (
                  <div className="space-y-2">
                    <div className="text-sm">
                      <span className="font-medium">Type:</span> {relationship.details.targetEntity.type || 'Unknown'}
                    </div>
                    {relationship.details.targetEntity.description && (
                      <div className="text-sm">
                        <span className="font-medium">Description:</span> {relationship.details.targetEntity.description}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Additional Context */}
            {relationship.details?.context && (
              <div>
                <h4 className="text-lg font-medium text-gray-900 mb-3">Context</h4>
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="text-sm text-gray-700">
                    {relationship.details.context}
                  </div>
                </div>
              </div>
            )}

            {/* Related Relationships */}
            {relationship.details?.relatedRelationships && relationship.details.relatedRelationships.length > 0 && (
              <div>
                <h4 className="text-lg font-medium text-gray-900 mb-3">Related Relationships</h4>
                <div className="space-y-2">
                  {relationship.details.relatedRelationships.map((rel: any, index: number) => (
                    <div key={index} className="bg-yellow-50 rounded-lg p-3 border border-yellow-200">
                      <div className="flex items-center justify-between">
                        <div className="text-sm">
                          <span className="font-medium">{rel.source}</span>
                          <span className="text-gray-500 mx-2">→</span>
                          <span className="font-medium">{rel.target}</span>
                        </div>
                        <span className="text-xs bg-yellow-200 text-yellow-800 px-2 py-1 rounded">
                          {rel.type}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="mt-6 flex justify-end space-x-3">
            <button
              onClick={() => handleEntityClick(relationship.source)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Explore {relationship.source}
            </button>
            <button
              onClick={() => handleEntityClick(relationship.target)}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
            >
              Explore {relationship.target}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
