import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, FileText, ChevronDown } from "lucide-react";

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

interface FormConfig {
  title: string;
  description: string;
  fields: FormField[];
}

const OnFormSubmissionUI: React.FC<OnFormSubmissionUIProps> = ({ onBack, onSave }) => {
  const [formConfig, setFormConfig] = useState<FormConfig>({
    title: '',
    description: '',
    fields: [
      {
        id: '1',
        name: 'Field 1',
        placeholder: '',
        type: 'file'
      }
    ]
  });

  const [showConfigPanel, setShowConfigPanel] = useState(true);
  const [expandedFieldId, setExpandedFieldId] = useState<string | null>('1');

  const handleSave = () => {
    onSave?.(formConfig);
  };

  const addNewField = () => {
    const newField: FormField = {
      id: Date.now().toString(),
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
                  <svg 
                    xmlns="http://www.w3.org/2000/svg" 
                    width="16" 
                    height="16" 
                    viewBox="0 0 16 16" 
                    fill="none"
                    style={{ aspectRatio: '1/1' }}
                  >
                    <path d="M10.794 1.33301C12.8533 1.33301 14 2.51967 14 4.55301V11.4397C14 13.5063 12.8533 14.6663 10.794 14.6663H5.20667C3.18 14.6663 2 13.5063 2 11.4397V4.55301C2 2.51967 3.18 1.33301 5.20667 1.33301H10.794ZM5.38667 10.493C5.18667 10.473 4.99333 10.5663 4.88667 10.7397C4.78 10.9063 4.78 11.1263 4.88667 11.2997C4.99333 11.4663 5.18667 11.5663 5.38667 11.5397H10.6133C10.8793 11.513 11.08 11.2857 11.08 11.0197C11.08 10.7463 10.8793 10.5197 10.6133 10.493H5.38667ZM10.6133 7.45234H5.38667C5.09933 7.45234 4.86667 7.68634 4.86667 7.97301C4.86667 8.25967 5.09933 8.49301 5.38667 8.49301H10.6133C10.9 8.49301 11.1333 8.25967 11.1333 7.97301C11.1333 7.68634 10.9 7.45234 10.6133 7.45234ZM7.37933 4.43301H5.38667V4.43967C5.09933 4.43967 4.86667 4.67301 4.86667 4.95967C4.86667 5.24634 5.09933 5.47967 5.38667 5.47967H7.37933C7.66667 5.47967 7.9 5.24634 7.9 4.95234C7.9 4.66634 7.66667 4.43301 7.37933 4.43301Z" fill="#395A0C"/>
                  </svg>
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
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <circle cx="6" cy="6" r="5.5" fill="white" stroke="#A0A7AB"/>
                </svg>
              </div>
            </div>

            {/* Bottom connection line and plus button */}
            <div className="absolute left-1/2 transform -translate-x-1/2 flex flex-col items-center" style={{ top: 'calc(100% + 8px)' }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="2" height="26" viewBox="0 0 2 26" fill="none">
                <path d="M1 1V25" stroke="#C9CCCF" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
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
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M7.99967 12.6663V7.99967M7.99967 7.99967V3.33301M7.99967 7.99967L3.33301 7.99967M7.99967 7.99967L12.6663 7.99967" stroke="#788187" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
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
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path fillRule="evenodd" clipRule="evenodd" d="M20.958 10.9995H7.38002L12.422 5.97852L11.011 4.56152L3.54102 12.0005L11.011 19.4385L12.422 18.0215L7.37802 12.9995H20.958V10.9995Z" fill="#181B1D"/>
              </svg>
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
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path fillRule="evenodd" clipRule="evenodd" d="M13.4142 12.0002L18.7072 6.70725C19.0982 6.31625 19.0982 5.68425 18.7072 5.29325C18.3162 4.90225 17.6842 4.90225 17.2932 5.29325L12.0002 10.5862L6.70725 5.29325C6.31625 4.90225 5.68425 4.90225 5.29325 5.29325C4.90225 5.68425 4.90225 6.31625 5.29325 6.70725L10.5862 12.0002L5.29325 17.2933C4.90225 17.6842 4.90225 18.3162 5.29325 18.7072C5.48825 18.9022 5.74425 19.0002 6.00025 19.0002C6.25625 19.0002 6.51225 18.9022 6.70725 18.7072L12.0002 13.4143L17.2932 18.7072C17.4882 18.9022 17.7442 19.0002 18.0002 19.0002C18.2562 19.0002 18.5122 18.9022 18.7072 18.7072C19.0982 18.3162 19.0982 17.6842 18.7072 17.2933L13.4142 12.0002Z" fill="black"/>
              </svg>
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
