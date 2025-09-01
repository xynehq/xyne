import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, FileText, ChevronDown } from "lucide-react";
import { FormDocumentIcon, ConnectionPointIcon, VerticalLineIcon, FormPlusIcon, BackArrowIcon, CloseIcon } from './WorkflowIcons';

interface OnFormSubmissionUIProps {
  onBack: () => void;
  onSave?: (formConfig: FormConfig) => void;
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

const OnFormSubmissionUI: React.FC<OnFormSubmissionUIProps> = ({ onBack, onSave }) => {
  const initialFieldId = crypto.randomUUID();
  
  const [formConfig, setFormConfig] = useState<FormConfig>({
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
  });

  const [showConfigPanel, setShowConfigPanel] = useState(true);
  const [expandedFieldId, setExpandedFieldId] = useState<string | null>(initialFieldId);

  const handleSave = () => {
    onSave?.(formConfig);
  };

  const addNewField = () => {
    const newField: FormField = {
      id: crypto.randomUUID(),
      name: `Field ${formConfig.fields.length + 1}`,
      placeholder: '',
      type: 'text'
    };
    setFormConfig(prev => ({
      ...prev,
      fields: [...prev.fields, newField]
    }));
    setExpandedFieldId(newField.id);
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
    if (expandedFieldId === fieldId) {
      setExpandedFieldId(null);
    }
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
    <div className="w-full h-full flex flex-col bg-white relative">
      {/* Main Content Area with Dotted Background */}
      <div 
        className="h-full relative"
        style={{
          backgroundColor: '#f9fafb',
          backgroundImage: 'radial-gradient(circle, #d1d5db 1px, transparent 1px)',
          backgroundSize: '20px 20px',
          backgroundPosition: '0 0'
        }}
      >

        {/* Center - Form Submission Card */}
        <div className="absolute inset-0 flex items-center justify-center z-[1]">
          <div 
            className="relative cursor-pointer hover:shadow-lg transition-shadow"
            onClick={() => setShowConfigPanel(true)}
          >
            {/* Form Submission Node Card */}
            <div 
              className="relative text-left flex flex-col justify-center items-center"
              style={{
                width: '320px',
                height: '122px',
                borderRadius: '12px',
                border: '2px solid #181B1D',
                background: '#FFF',
                boxShadow: '0 0 0 2px #E2E2E2'
              }}
            >
              {/* Header with icon and title */}
              <div className="flex items-center gap-3 text-left w-full px-4 mb-3">
                {/* Green document icon with background */}
                <div 
                  className="flex justify-center items-center flex-shrink-0"
                  style={{
                    display: 'flex',
                    width: '24px',
                    height: '24px',
                    padding: '4px',
                    justifyContent: 'center',
                    alignItems: 'center',
                    borderRadius: '4.8px',
                    background: '#E8F9D1'
                  }}
                >
                  <FormDocumentIcon width={16} height={16} />
                </div>
                
                <h3 
                  className="text-gray-800"
                  style={{
                    fontFamily: 'Inter',
                    fontSize: '14px',
                    fontStyle: 'normal',
                    fontWeight: '600',
                    lineHeight: 'normal',
                    letterSpacing: '-0.14px',
                    color: '#3B4145'
                  }}
                >
                  Form Submission
                </h3>
              </div>
              
              {/* Full-width horizontal divider */}
              <div className="w-full h-px bg-gray-200 mb-3"></div>
              
              {/* Description text */}
              <div className="px-4">
                <p className="text-gray-600 text-sm leading-relaxed">
                  Upload a file in formats such as PDF, DOCX, or JPG.
                </p>
              </div>

              {/* Bottom center connection point */}
              <div className="absolute -bottom-1.5 left-1/2 transform -translate-x-1/2">
                <ConnectionPointIcon width={12} height={12} />
              </div>
            </div>

            {/* Bottom connection line and plus button */}
            <div className="absolute left-1/2 transform -translate-x-1/2 flex flex-col items-center" style={{ top: 'calc(100% + 8px)' }}>
              <VerticalLineIcon width={2} height={26} />
              <div className="mt-2">
                <div 
                  style={{
                    display: 'inline-flex',
                    padding: '6px',
                    justifyContent: 'center',
                    alignItems: 'center',
                    gap: '10px',
                    borderRadius: '24px',
                    background: '#F2F2F3'
                  }}
                >
                  <FormPlusIcon width={16} height={16} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Panel - Form Configuration (slides in) */}
        <div className={`absolute top-0 right-0 h-full bg-white border-l border-slate-200 flex flex-col overflow-hidden transition-transform duration-300 ease-in-out z-[5] ${
          showConfigPanel ? 'translate-x-0 w-[400px]' : 'translate-x-full w-0'
        }`}>
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
              onClick={() => setShowConfigPanel(false)}
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
                        onClick={() => setExpandedFieldId(expandedFieldId === field.id ? null : field.id)}
                      >
                        <div className="flex items-center gap-3">
                          {getFieldTypeIcon(field.type)}
                          <span className="font-medium text-slate-900">{field.name}</span>
                        </div>
                        <ChevronDown 
                          className={`w-4 h-4 text-slate-500 transition-transform ${
                            expandedFieldId === field.id ? 'rotate-180' : ''
                          }`} 
                        />
                      </div>
                      
                      {/* Field Configuration */}
                      {expandedFieldId === field.id && (
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

                  {/* Add Field Button */}
                  <Button
                    variant="outline"
                    onClick={addNewField}
                    className="w-full flex items-center gap-2 border-dashed border-slate-300 hover:border-slate-400 text-slate-600"
                  >
                    <Plus size={16} />
                    Add Field
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Panel Footer */}
          <div className="px-4 py-3 border-t border-slate-200 bg-gray-50">
            <Button 
              onClick={handleSave}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white"
            >
              Save Configuration
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OnFormSubmissionUI;
