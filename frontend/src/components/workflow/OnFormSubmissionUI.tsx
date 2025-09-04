import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FileText, ChevronDown } from "lucide-react";
import { BackArrowIcon, CloseIcon } from './WorkflowIcons';

interface OnFormSubmissionUIProps {
  onBack: () => void;
  onSave?: (formConfig: FormConfig) => void;
  initialConfig?: FormConfig;
}

interface FormField {
  id: string;
  name: string;
  placeholder: string;
  type: 'text' | 'email' | 'file' | 'number' | 'textarea';
}

export interface FormConfig {
  title: string;
  description: string;
  fields: FormField[];
}

const OnFormSubmissionUI: React.FC<OnFormSubmissionUIProps> = ({ onBack, onSave, initialConfig }) => {
  const initialFieldId = crypto.randomUUID();
  
  const [formConfig, setFormConfig] = useState<FormConfig>(
    initialConfig || {
      title: '',
      description: '',
      fields: [
        {
          id: initialFieldId,
          name: 'Field 1',
          placeholder: '',
          type: 'file'
        }
      ]
    }
  );

  const [collapsedFieldIds, setCollapsedFieldIds] = useState<Set<string>>(new Set());

  const handleSave = () => {
    onSave?.(formConfig);
  };

  const updateField = (fieldId: string, updates: Partial<FormField>) => {
    setFormConfig(prev => ({
      ...prev,
      fields: prev.fields.map(field => 
        field.id === fieldId ? { ...field, ...updates } : field
      )
    }));
  };

  const removeField = (fieldId: string) => {
    setFormConfig(prev => ({
      ...prev,
      fields: prev.fields.filter(field => field.id !== fieldId)
    }));
    // Remove from collapsed set if it was there
    setCollapsedFieldIds(prev => {
      const newSet = new Set(prev);
      newSet.delete(fieldId);
      return newSet;
    });
  };

  const getFieldTypeIcon = (type: string) => {
    switch (type) {
      case 'file':
        return <FileText className="w-4 h-4" />;
      default:
        return <FileText className="w-4 h-4" />;
    }
  };

  return (
    <div className={`h-full bg-white border-l border-slate-200 flex flex-col overflow-hidden transition-transform duration-300 ease-in-out w-[400px]`}>
          {/* Panel Header */}
          <div 
            className="flex items-center border-b"
            style={{
              display: 'flex',
              padding: '20px',
              alignItems: 'center',
              gap: '10px',
              alignSelf: 'stretch',
              borderBottom: '1px solid var(--gray-300, #E4E6E7)'
            }}
          >
            <button
              onClick={onBack}
              className="flex items-center justify-center"
              style={{
                width: '24px',
                height: '24px',
                padding: '0',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer'
              }}
            >
              <BackArrowIcon width={24} height={24} />
            </button>
            
            <h2 
              className="flex-1"
              style={{
                alignSelf: 'stretch',
                color: 'var(--gray-900, #181B1D)',
                fontFamily: 'Inter',
                fontSize: '16px',
                fontStyle: 'normal',
                fontWeight: '600',
                lineHeight: 'normal',
                letterSpacing: '-0.16px',
                textTransform: 'capitalize'
              }}
            >
              On form submission
            </h2>
            
            <button
              onClick={onBack}
              className="flex items-center justify-center"
              style={{
                width: '24px',
                height: '24px',
                padding: '0',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer'
              }}
            >
              <CloseIcon width={24} height={24} />
            </button>
          </div>

          {/* Panel Content */}
          <div className="flex-1 overflow-y-auto px-4 py-3">
            <div className="space-y-4">
              {/* Form Title */}
              <div className="space-y-2">
                <Label htmlFor="form-title" className="text-sm font-medium text-slate-700">
                  Form Title
                </Label>
                <Input
                  id="form-title"
                  value={formConfig.title}
                  onChange={(e) => setFormConfig(prev => ({ ...prev, title: e.target.value }))}
                  placeholder="type here"
                  className="w-full"
                />
              </div>

              {/* Form Description */}
              <div className="space-y-2">
                <Label htmlFor="form-description" className="text-sm font-medium text-slate-700">
                  Form Description
                </Label>
                <Textarea
                  id="form-description"
                  value={formConfig.description}
                  onChange={(e) => setFormConfig(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="type here"
                  className="w-full min-h-[80px] resize-none"
                />
              </div>

              {/* Divider */}
              <div className="w-full h-px bg-slate-200"></div>

              {/* Form Elements */}
              <div className="space-y-3">
                <Label className="text-sm font-medium text-slate-700">
                  Form Elements
                </Label>
                
                <div className="space-y-3">
                  {formConfig.fields.map((field) => (
                    <div key={field.id} className="border border-slate-200 rounded-lg bg-white">
                      {/* Field Header */}
                      <div 
                        className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-50"
                        onClick={() => setCollapsedFieldIds(prev => {
                          const newSet = new Set(prev);
                          if (newSet.has(field.id)) {
                            newSet.delete(field.id); // Expand (remove from collapsed)
                          } else {
                            newSet.add(field.id); // Collapse (add to collapsed)
                          }
                          return newSet;
                        })}
                      >
                        <div className="flex items-center gap-3">
                          {getFieldTypeIcon(field.type)}
                          <span className="font-medium text-slate-900">{field.name}</span>
                        </div>
                        <ChevronDown 
                          className={`w-4 h-4 text-slate-500 transition-transform ${
                            !collapsedFieldIds.has(field.id) ? 'rotate-180' : ''
                          }`} 
                        />
                      </div>
                      
                      {/* Field Configuration */}
                      {!collapsedFieldIds.has(field.id) && (
                        <div className="border-t border-slate-200 p-4 space-y-4">
                          {/* Field Name */}
                          <div className="space-y-2">
                            <Label className="text-sm font-medium text-slate-700">
                              Field Name
                            </Label>
                            <Input
                              value={field.name}
                              onChange={(e) => updateField(field.id, { name: e.target.value })}
                              placeholder="type here"
                              className="w-full"
                            />
                          </div>

                          {/* Placeholder Text */}
                          <div className="space-y-2">
                            <Label className="text-sm font-medium text-slate-700">
                              Placeholder Text
                            </Label>
                            <Input
                              value={field.placeholder}
                              onChange={(e) => updateField(field.id, { placeholder: e.target.value })}
                              placeholder="type here"
                              className="w-full"
                            />
                          </div>

                          {/* Element Type */}
                          <div className="space-y-2">
                            <Label className="text-sm font-medium text-slate-700">
                              Element Type
                            </Label>
                            <div className="relative">
                              <select
                                value={field.type}
                                onChange={(e) => updateField(field.id, { type: e.target.value as FormField['type'] })}
                                className="w-full h-9 px-3 py-1 bg-white border border-slate-200 rounded-md text-sm text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400 appearance-none cursor-pointer"
                                style={{
                                  background: 'white',
                                  color: '#1f2937'
                                }}
                              >
                                <option value="file" style={{ background: 'white', color: '#1f2937' }}>File</option>
                                <option value="text" style={{ background: 'white', color: '#1f2937' }}>Text</option>
                                <option value="email" style={{ background: 'white', color: '#1f2937' }}>Email</option>
                                <option value="number" style={{ background: 'white', color: '#1f2937' }}>Number</option>
                                <option value="textarea" style={{ background: 'white', color: '#1f2937' }}>Textarea</option>
                              </select>
                              <ChevronDown className="absolute right-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
                            </div>
                          </div>

                          {/* Remove Field Button */}
                          {formConfig.fields.length > 1 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => removeField(field.id)}
                              className="w-full text-red-600 border-red-200 hover:bg-red-50"
                            >
                              Remove Field
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Panel Footer */}
          <div className="px-4 py-3 border-t border-slate-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
            <Button 
              onClick={handleSave}
              className="w-full bg-black hover:bg-gray-800 text-white"
            >
              Save Configuration
            </Button>
          </div>
    </div>
  );
};

export default OnFormSubmissionUI;