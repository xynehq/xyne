import { db } from "./db/client.ts"
import {
  workflowTemplate,
  workflowStepTemplate,
  workflowTool,
} from "./db/schema.ts"
import { createId } from "@paralleldrive/cuid2"

async function createAIAgentWorkflow() {
  try {
    console.log("Starting AI Agent workflow creation...")

    // 1. Create the main workflow template
    const [workflowTemplateResult] = await db
      .insert(workflowTemplate)
      .values({
        name: "AI Agent Document Analysis",
        description:
          "Analyze documents using configurable AI models with custom prompts",
        version: "1.0.0",
        status: "active",
        config: {
          recipients: [],
          maxFileSize: "25MB",
          analysisType: "ai-agent-powered",
          supportedFormats: [
            "pdf",
            "jpg",
            "jpeg",
            "png",
            "gif",
            "bmp",
            "doc",
            "docx",
            "txt",
            "rtf",
          ],
        },
        createdBy: "system",
      })
      .returning()

    console.log("Created workflow template:", workflowTemplateResult.id)

    // 2. Create form tool for step 1 (file upload + prompt input)
    const [formTool] = await db
      .insert(workflowTool)
      .values({
        type: "form",
        value: {
          title: "AI Agent Document Analysis",
          fields: [
            {
              id: "document_file",
              type: "file",
              label: "Document",
              maxSize: "25MB",
              required: true,
              fileTypes: [
                "pdf",
                "jpg",
                "jpeg",
                "png",
                "gif",
                "bmp",
                "doc",
                "docx",
                "txt",
                "rtf",
              ],
              description: "Upload document for AI analysis",
            },
            {
              id: "custom_prompt",
              type: "textarea",
              label: "Analysis Prompt",
              required: true,
              placeholder: "Enter your custom analysis prompt here...",
              description:
                "Describe what you want the AI to analyze in the document",
              rows: 4,
            },
            {
              id: "ai_model",
              type: "select",
              label: "AI Model",
              required: true,
              options: [
                { value: "gemini-1.5-flash", label: "Gemini 1.5 Flash (Fast)" },
                { value: "gemini-1.5-pro", label: "Gemini 1.5 Pro (Advanced)" },
                { value: "gemini-1.0-pro", label: "Gemini 1.0 Pro (Stable)" },
              ],
              defaultValue: "gemini-1.5-flash",
              description: "Choose the AI model for analysis",
            },
          ],
          description: "Upload document and configure AI analysis",
        },
        config: {
          submitText: "Analyze with AI",
          validation: "strict",
        },
        createdBy: "system",
      })
      .returning()

    console.log("Created form tool:", formTool.id)

    // 3. Create AI Agent tool for step 2
    const aiAgentScriptContent = `
import json
import os
import sys
from datetime import datetime
import requests
import base64

# Import document processing libraries
try:
    import PyPDF2
    import pdfplumber
    from docx import Document
    from PIL import Image
    import pytesseract
except ImportError as e:
    print(f"Missing library: {e}")

# Gemini API Configuration
GEMINI_API_KEY = ""

def call_gemini_api(content, prompt, model_name, file_name):
    """Make actual Gemini API call for document analysis"""
    try:
        # Determine API endpoint based on model
        if model_name.startswith('gemini-1.5'):
            base_url = "https://generativelanguage.googleapis.com/v1beta/models"
        else:
            base_url = "https://generativelanguage.googleapis.com/v1/models"
        
        url = f"{base_url}/{model_name}:generateContent?key={GEMINI_API_KEY}"
        
        headers = {
            "Content-Type": "application/json"
        }
        
        # Create the analysis prompt
        full_prompt = f"""
Document Name: {file_name}

Document Content:
{content[:8000]}

Analysis Request:
{prompt}

Please provide a comprehensive analysis based on the request above.
"""
        
        payload = {
            "contents": [{
                "parts": [{
                    "text": full_prompt
                }]
            }],
            "generationConfig": {
                "temperature": 0.3,
                "topK": 40,
                "topP": 0.95,
                "maxOutputTokens": 2048
            },
            "safetySettings": [
                {
                    "category": "HARM_CATEGORY_HARASSMENT",
                    "threshold": "BLOCK_MEDIUM_AND_ABOVE"
                },
                {
                    "category": "HARM_CATEGORY_HATE_SPEECH",
                    "threshold": "BLOCK_MEDIUM_AND_ABOVE"
                },
                {
                    "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    "threshold": "BLOCK_MEDIUM_AND_ABOVE"
                },
                {
                    "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                    "threshold": "BLOCK_MEDIUM_AND_ABOVE"
                }
            ]
        }
        
        response = requests.post(url, headers=headers, json=payload, timeout=60)
        
        if response.status_code == 200:
            result = response.json()
            if 'candidates' in result and len(result['candidates']) > 0:
                analysis = result['candidates'][0]['content']['parts'][0]['text']
                return {
                    "success": True,
                    "analysis": analysis,
                    "model_used": model_name,
                    "usage": result.get("usageMetadata", {})
                }
            else:
                return {
                    "success": False,
                    "error": "No valid response from Gemini API"
                }
        else:
            return {
                "success": False,
                "error": f"Gemini API error: {response.status_code} - {response.text}"
            }
            
    except Exception as e:
        return {
            "success": False,
            "error": f"Gemini API call failed: {str(e)}"
        }

def extract_document_content(file_path, file_ext):
    """Extract text content from various document types"""
    extracted_content = ""
    
    try:
        if file_ext == 'pdf':
            with pdfplumber.open(file_path) as pdf:
                text_content = ""
                for page in pdf.pages:
                    page_text = page.extract_text()
                    if page_text:
                        text_content += page_text + "\\\\n"
                extracted_content = text_content.strip()
                
        elif file_ext in ['doc', 'docx']:
            doc = Document(file_path)
            paragraphs = []
            for paragraph in doc.paragraphs:
                if paragraph.text.strip():
                    paragraphs.append(paragraph.text.strip())
            extracted_content = "\\\\n".join(paragraphs)
            
        elif file_ext in ['txt', 'md', 'rtf']:
            with open(file_path, 'r', encoding='utf-8') as f:
                extracted_content = f.read()
                
        elif file_ext in ['jpg', 'jpeg', 'png', 'gif', 'bmp']:
            image = Image.open(file_path)
            extracted_content = pytesseract.image_to_string(image).strip()
            
    except Exception as e:
        extracted_content = f"Error extracting content: {str(e)}"
        
    return extracted_content

# Get form data from previous step
form_data = previous_step_results.get("Document Upload", {}).get("formSubmission", {}).get("formData", {})

document_file = form_data.get("document_file")
custom_prompt = form_data.get("custom_prompt", "Please analyze this document")
ai_model = form_data.get("ai_model", "gemini-1.5-flash")

if not document_file:
    result = {
        "status": "error",
        "error": "No file found"
    }
elif not custom_prompt.strip():
    result = {
        "status": "error",
        "error": "No analysis prompt provided"
    }
else:
    try:
        file_path = document_file["absolutePath"]
        file_name = document_file["originalFileName"]
        file_ext = document_file["fileExtension"].lower()
        file_size = document_file.get("fileSize", 0)
        
        # Extract content from document
        extracted_content = extract_document_content(file_path, file_ext)
        
        if not extracted_content or len(extracted_content.strip()) < 10:
            result = {
                "status": "error",
                "error": "No readable content could be extracted from the document"
            }
        else:
            # Make actual Gemini API call
            gemini_response = call_gemini_api(extracted_content, custom_prompt, ai_model, file_name)
            
            if gemini_response["success"]:
                result = {
                    "status": "success",
                    "ai_analysis": gemini_response["analysis"],
                    "model_used": gemini_response["model_used"],
                    "usage_stats": gemini_response["usage"],
                    "extracted_content_length": len(extracted_content),
                    "file_name": file_name,
                    "file_size": file_size,
                    "custom_prompt": custom_prompt,
                    "processed_at": datetime.now().isoformat()
                }
            else:
                result = {
                    "status": "error",
                    "error": f"AI analysis failed: {gemini_response['error']}",
                    "extracted_content_length": len(extracted_content),
                    "file_name": file_name,
                    "custom_prompt": custom_prompt
                }
                
    except Exception as e:
        result = {
            "status": "error",
            "error": f"Failed to process document: {str(e)}"
        }
`

    const [aiAgentTool] = await db
      .insert(workflowTool)
      .values({
        type: "ai_agent",
        value: aiAgentScriptContent.trim(),
        config: {
          timeout: 600,
          gemini_api_key: "",
          supported_models: [
            "gemini-1.5-flash",
            "gemini-1.5-pro",
            "gemini-1.0-pro",
          ],
          description:
            "AI-powered document analysis using configurable Gemini models",
        },
        createdBy: "system",
      })
      .returning()

    console.log("Created AI Agent tool:", aiAgentTool.id)

    // 4. Create enhanced email tool for step 3
    const emailScriptContent = `
import json
from datetime import datetime

# Get data from previous steps
analysis_data = previous_step_results.get("AI Content Analysis", {}).get("result", {})
form_data = previous_step_results.get("Document Upload", {}).get("formSubmission", {}).get("formData", {})

# Get recipients from workflow config
recipients = []  # Default recipients
from_email = "no-reply@xyne.io"

if analysis_data.get("status") != "success":
    error_msg = analysis_data.get("error", "Unknown error occurred")
    
    # Send error email to all recipients
    result = {
        "to": recipients,
        "from": from_email,
        "subject": "❌ AI Analysis Failed",
        "body": f'''
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {{ font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }}
        .container {{ max-width: 700px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }}
        .header {{ background: linear-gradient(135deg, #dc3545 0%, #c82333 100%); color: white; padding: 30px; text-align: center; }}
        .content {{ padding: 30px; }}
        .error-box {{ background: #f8d7da; padding: 20px; border-radius: 8px; border: 1px solid #f5c6cb; color: #721c24; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>❌ AI Analysis Failed</h1>
        </div>
        <div class="content">
            <div class="error-box">
                <strong>Error:</strong> {error_msg}
            </div>
        </div>
    </div>
</body>
</html>
        ''',
        "content_type": "text/html"
    }
else:
    file_name = analysis_data.get("file_name", "Document")
    ai_analysis = analysis_data.get("ai_analysis", "No analysis available")
    model_used = analysis_data.get("model_used", "Unknown")
    usage_stats = analysis_data.get("usage_stats", {})
    content_length = analysis_data.get("extracted_content_length", 0)
    processed_at = analysis_data.get("processed_at", "Unknown")
    custom_prompt = analysis_data.get("custom_prompt", "No prompt provided")
    
    subject = f"🤖 AI Analysis: {file_name}"
    
    # Create HTML email with AI analysis
    html_body = f'''
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {{ font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }}
        .container {{ max-width: 700px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }}
        .header {{ background: linear-gradient(135deg, #4285f4 0%, #3367d6 100%); color: white; padding: 30px; text-align: center; }}
        .header h1 {{ margin: 0; font-size: 24px; font-weight: 400; }}
        .header .badge {{ background: rgba(255,255,255,0.2); padding: 5px 15px; border-radius: 20px; font-size: 14px; margin-top: 10px; display: inline-block; }}
        .content {{ padding: 30px; }}
        .file-info {{ background: #e3f2fd; padding: 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #4285f4; }}
        .prompt-box {{ background: #f3e5f5; padding: 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #9c27b0; }}
        .analysis-box {{ background: #f8f9fa; padding: 25px; border-radius: 8px; border: 1px solid #dee2e6; }}
        .analysis-content {{ color: #2c3e50; line-height: 1.8; white-space: pre-line; font-size: 15px; }}
        .stats {{ display: flex; justify-content: space-around; background: #e9ecef; padding: 15px; border-radius: 8px; margin: 20px 0; }}
        .stat {{ text-align: center; }}
        .stat-number {{ font-size: 18px; font-weight: bold; color: #4285f4; }}
        .footer {{ background: #2c3e50; color: white; padding: 20px; text-align: center; font-size: 14px; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 AI Agent Analysis</h1>
            <div class="badge">Powered by {model_used}</div>
        </div>
        
        <div class="content">
            <div class="file-info">
                <strong>📄 File:</strong> {file_name}<br>
                <strong>🤖 AI Model:</strong> {model_used}<br>
                <strong>📊 Content Length:</strong> {content_length:,} characters<br>
                <strong>⏰ Processed:</strong> {processed_at}
            </div>

            <div class="prompt-box">
                <h3 style="color: #9c27b0; margin-top: 0;">💭 Analysis Prompt:</h3>
                <div style="font-style: italic;">{custom_prompt}</div>
            </div>

            <div class="stats">
                <div class="stat">
                    <div class="stat-number">🤖</div>
                    <div>AI Analysis</div>
                </div>
                <div class="stat">
                    <div class="stat-number">{usage_stats.get('totalTokenCount', 'N/A')}</div>
                    <div>Tokens</div>
                </div>
                <div class="stat">
                    <div class="stat-number">🧠</div>
                    <div>Gemini</div>
                </div>
            </div>

            <div class="analysis-box">
                <h3 style="color: #4285f4; margin-top: 0;">🧠 AI Analysis Results:</h3>
                <div class="analysis-content">{ai_analysis}</div>
            </div>
        </div>
        
        <div class="footer">
            🤖 AI Agent Analysis • Powered by {model_used} • Custom AI Processing
        </div>
    </div>
</body>
</html>
    '''

    result = {
        "to": recipients,
        "from": from_email,
        "subject": subject,
        "body": html_body,
        "content_type": "text/html"
    }
`

    const [emailTool] = await db
      .insert(workflowTool)
      .values({
        type: "email",
        value: emailScriptContent.trim(),
        config: {
          recipients: [],
          from_email: "no-reply@xyne.io",
          content_type: "html",
        },
        createdBy: "system",
      })
      .returning()

    console.log("Created email tool:", emailTool.id)

    // 5. Create workflow steps
    // Step 1: Document Upload with Prompt Input (manual)
    const [step1] = await db
      .insert(workflowStepTemplate)
      .values({
        workflowTemplateId: workflowTemplateResult.id,
        name: "Document Upload",
        description: "Upload document and configure AI analysis prompt",
        type: "manual",
        parentStepId: null,
        prevStepIds: [],
        nextStepIds: [],
        toolIds: [formTool.id],
        timeEstimate: 120,
        metadata: {
          icon: "📁",
          step_order: 1,
          user_instructions:
            "Upload document, enter custom prompt, and select AI model",
        },
      })
      .returning()

    console.log("Created step 1:", step1.id)

    // Step 2: AI Content Analysis (automated)
    const [step2] = await db
      .insert(workflowStepTemplate)
      .values({
        workflowTemplateId: workflowTemplateResult.id,
        name: "AI Content Analysis",
        description:
          "Analyze document content using configurable AI model with custom prompt",
        type: "automated",
        parentStepId: null,
        prevStepIds: [],
        nextStepIds: [],
        toolIds: [aiAgentTool.id],
        timeEstimate: 300,
        metadata: {
          icon: "🤖",
          step_order: 2,
          automated_description: "Processing document with custom AI prompt",
        },
      })
      .returning()

    console.log("Created step 2:", step2.id)

    // Step 3: AI Analysis Email (automated)
    const [step3] = await db
      .insert(workflowStepTemplate)
      .values({
        workflowTemplateId: workflowTemplateResult.id,
        name: "AI Analysis Email",
        description: "Send AI analysis results to multiple recipients",
        type: "automated",
        parentStepId: null,
        prevStepIds: [],
        nextStepIds: [],
        toolIds: [emailTool.id],
        timeEstimate: 30,
        metadata: {
          icon: "📧",
          step_order: 3,
          automated_description: "Sending AI analysis to recipients",
        },
      })
      .returning()

    console.log("Created step 3:", step3.id)

    // 6. Update step relationships for proper workflow flow
    await db
      .update(workflowStepTemplate)
      .set({ nextStepIds: [step2.id] })
      .where({ id: step1.id })

    await db
      .update(workflowStepTemplate)
      .set({
        prevStepIds: [step1.id],
        nextStepIds: [step3.id],
      })
      .where({ id: step2.id })

    await db
      .update(workflowStepTemplate)
      .set({ prevStepIds: [step2.id] })
      .where({ id: step3.id })

    // 7. Update workflow template with root step
    await db
      .update(workflowTemplate)
      .set({
        rootWorkflowStepTemplateId: step1.id,
        status: "active",
      })
      .where({ id: workflowTemplateResult.id })

    console.log("✅ Successfully created AI Agent workflow template!")
    console.log("Template ID:", workflowTemplateResult.id)
    console.log("Root Step ID:", step1.id)
    console.log("Steps created: 3")
    console.log("Tools created: 3")

    return {
      templateId: workflowTemplateResult.id,
      rootStepId: step1.id,
      tools: {
        form: formTool.id,
        aiAgent: aiAgentTool.id,
        email: emailTool.id,
      },
      steps: {
        upload: step1.id,
        analysis: step2.id,
        email: step3.id,
      },
    }
  } catch (error) {
    console.error("Error creating AI Agent workflow:", error)
    throw error
  }
}

createAIAgentWorkflow()
  .then((result) => {
    console.log("AI Agent workflow creation completed:", result)
    process.exit(0)
  })
  .catch((error) => {
    console.error("Failed to create AI Agent workflow:", error)
    process.exit(1)
  })
