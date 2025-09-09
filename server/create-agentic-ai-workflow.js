import { db } from "./db/client.ts"
import {
  workflowTemplate,
  workflowStepTemplate,
  workflowTool,
} from "./db/schema.ts"

async function createAgenticAIWorkflow() {
  try {
    console.log("Starting Agentic AI workflow creation...")

    // 1. Create the main workflow template
    const [workflowTemplateResult] = await db
      .insert(workflowTemplate)
      .values({
        name: "Agentic AI Document Analysis",
        description:
          "Upload document, get AI summary using agentic AI, and receive results via email",
        version: "1.0.0",
        status: "active",
        config: {
          ai_model: "gemini-1.5-flash",
          max_file_size: "25MB",
          auto_execution: true,
          recipients: ["yash.daga@juspay.in", "aman.asrani@juspay.in"],
          agentic_ai_enabled: true,
        },
        createdBy: "system",
      })
      .returning()

    console.log("Created workflow template:", workflowTemplateResult.id)

    // 2. Create form tool for step 1 (document upload)
    const [formTool] = await db
      .insert(workflowTool)
      .values({
        type: "form",
        value: {
          title: "Document Upload for AI Analysis",
          fields: [
            {
              id: "document_file",
              type: "file",
              label: "Upload Document",
              maxSize: "25MB",
              required: true,
              fileTypes: ["pdf", "doc", "docx", "txt", "jpg", "jpeg", "png"],
              description: "Upload your document for AI analysis",
            },
            {
              id: "document_title",
              type: "text",
              label: "Document Title",
              required: true,
              placeholder: "Enter a descriptive title for your document",
              validation: {
                minLength: 3,
                maxLength: 100,
              },
            },
            {
              id: "analysis_focus",
              type: "select",
              label: "Analysis Focus",
              required: true,
              options: [
                { value: "general", label: "General Summary" },
                { value: "key_points", label: "Key Points & Highlights" },
                { value: "action_items", label: "Action Items & Tasks" },
                { value: "technical", label: "Technical Analysis" },
                { value: "financial", label: "Financial Information" },
              ],
              defaultValue: "general",
              description: "Choose the focus area for AI analysis",
            },
            {
              id: "summary_length",
              type: "select",
              label: "Summary Length",
              required: true,
              options: [
                { value: "brief", label: "Brief (1-2 paragraphs)" },
                { value: "standard", label: "Standard (3-5 paragraphs)" },
                { value: "detailed", label: "Detailed (5+ paragraphs)" },
              ],
              defaultValue: "standard",
            },
            {
              id: "custom_instructions",
              type: "textarea",
              label: "Additional Instructions",
              required: false,
              placeholder:
                "Any specific requirements or questions about the document...",
              rows: 3,
            },
          ],
          description:
            "Upload your document and configure AI analysis settings",
        },
        config: {
          submitText: "Start AI Analysis",
          validation: "strict",
        },
        createdBy: "system",
      })
      .returning()

    console.log("Created form tool:", formTool.id)

    // 3. Create agentic AI tool for step 2 (AI summary)
    const agenticAiScriptContent = `
import json
import os
import sys
from datetime import datetime
import requests

# Gemini API Configuration
GEMINI_API_KEY = "AIzaSyCdGmhO4rI7_5QlH8LWGg5rPAAGa6Z3iWw"

# Document processing libraries
try:
    import pdfplumber
    from docx import Document
    from PIL import Image
    import pytesseract
except ImportError as e:
    print(f"Missing library: {e}")

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
                        text_content += page_text + "\\n"
                extracted_content = text_content.strip()
                
        elif file_ext in ['doc', 'docx']:
            doc = Document(file_path)
            paragraphs = []
            for paragraph in doc.paragraphs:
                if paragraph.text.strip():
                    paragraphs.append(paragraph.text.strip())
            extracted_content = "\\n".join(paragraphs)
            
        elif file_ext in ['txt']:
            with open(file_path, 'r', encoding='utf-8') as f:
                extracted_content = f.read()
                
        elif file_ext in ['jpg', 'jpeg', 'png']:
            image = Image.open(file_path)
            extracted_content = pytesseract.image_to_string(image).strip()
            
    except Exception as e:
        extracted_content = f"Error extracting content: {str(e)}"
        
    return extracted_content

def call_gemini_agentic_api(content, analysis_focus, summary_length, custom_instructions, file_name):
    """Call Gemini API with agentic AI approach for document analysis"""
    try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={GEMINI_API_KEY}"
        
        headers = {"Content-Type": "application/json"}
        
        # Build focus-specific prompt
        focus_prompts = {
            'general': 'Provide a comprehensive general summary of the document',
            'key_points': 'Extract and highlight the key points, main ideas, and important highlights',
            'action_items': 'Identify action items, tasks, deadlines, and next steps',
            'technical': 'Focus on technical details, specifications, procedures, and methodologies',
            'financial': 'Analyze financial information, numbers, costs, revenue, and economic data'
        }
        
        length_instructions = {
            'brief': 'Keep the summary concise in 1-2 paragraphs',
            'standard': 'Provide a balanced summary in 3-5 paragraphs',
            'detailed': 'Create a comprehensive analysis in 5 or more paragraphs'
        }
        
        # Create agentic AI prompt with role and reasoning
        agentic_prompt = f"""
You are an expert document analyst with advanced reasoning capabilities. Your task is to analyze the provided document using an agentic approach.

DOCUMENT INFORMATION:
- Document Name: {file_name}
- Analysis Focus: {analysis_focus}
- Summary Length: {summary_length}

ANALYSIS INSTRUCTIONS:
1. {focus_prompts.get(analysis_focus, focus_prompts['general'])}
2. {length_instructions.get(summary_length, length_instructions['standard'])}
3. Use structured thinking and provide clear reasoning for your analysis
4. Format your response in clean HTML with proper headings and structure

ADDITIONAL REQUIREMENTS:
{custom_instructions if custom_instructions else "Follow standard analysis procedures"}

DOCUMENT CONTENT:
{content[:8000]}

Please provide your expert analysis with clear reasoning and structured insights. Format the response in HTML with proper headings, paragraphs, and bullet points for readability.
"""
        
        payload = {
            "contents": [{
                "parts": [{
                    "text": agentic_prompt
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
                    "model_used": "gemini-1.5-flash",
                    "agentic_approach": True,
                    "analysis_focus": analysis_focus,
                    "summary_length": summary_length,
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
            "error": f"Agentic AI call failed: {str(e)}"
        }

# Get form data from previous step
form_data = previous_step_results.get("Document Upload", {}).get("formSubmission", {}).get("formData", {})

document_file = form_data.get("document_file")
document_title = form_data.get("document_title", "Untitled Document")
analysis_focus = form_data.get("analysis_focus", "general")
summary_length = form_data.get("summary_length", "standard")
custom_instructions = form_data.get("custom_instructions", "")

if not document_file:
    result = {
        "status": "error",
        "error": "No document file found in form submission",
        "agentic_ai": True
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
                "error": "No readable content could be extracted from the document",
                "file_name": file_name,
                "agentic_ai": True
            }
        else:
            # Make agentic AI call to Gemini
            ai_response = call_gemini_agentic_api(
                extracted_content, 
                analysis_focus, 
                summary_length, 
                custom_instructions, 
                file_name
            )
            
            if ai_response["success"]:
                result = {
                    "status": "success",
                    "ai_analysis": ai_response["analysis"],
                    "analysis_focus": analysis_focus,
                    "summary_length": summary_length,
                    "model_used": ai_response["model_used"],
                    "usage_stats": ai_response["usage"],
                    "extracted_content_length": len(extracted_content),
                    "file_name": file_name,
                    "file_size": file_size,
                    "document_title": document_title,
                    "custom_instructions": custom_instructions,
                    "processed_at": datetime.now().isoformat(),
                    "agentic_ai": True,
                    "agentic_approach": True
                }
            else:
                result = {
                    "status": "error",
                    "error": f"Agentic AI analysis failed: {ai_response['error']}",
                    "file_name": file_name,
                    "document_title": document_title,
                    "agentic_ai": True
                }
                
    except Exception as e:
        result = {
            "status": "error",
            "error": f"Failed to process document: {str(e)}",
            "agentic_ai": True
        }
`

    const [agenticAiTool] = await db
      .insert(workflowTool)
      .values({
        type: "ai_agent",
        value: agenticAiScriptContent.trim(),
        config: {
          timeout: 600,
          gemini_api_key: "AIzaSyCdGmhO4rI7_5QlH8LWGg5rPAAGa6Z3iWw",
          agentic_approach: true,
          reasoning_enabled: true,
          model: "gemini-1.5-flash",
          description:
            "Agentic AI-powered document analysis with advanced reasoning",
        },
        createdBy: "system",
      })
      .returning()

    console.log("Created agentic AI tool:", agenticAiTool.id)

    // 4. Create email tool for step 3 (send results)
    const emailScriptContent = `
import json
from datetime import datetime

# Get data from previous steps
analysis_data = previous_step_results.get("Agentic AI Analysis", {}).get("result", {})
form_data = previous_step_results.get("Document Upload", {}).get("formSubmission", {}).get("formData", {})

# Email configuration
recipients = ["yash.daga@juspay.in", "aman.asrani@juspay.in"]
from_email = "aman.asrani@juspay.in"

if analysis_data.get("status") != "success":
    error_msg = analysis_data.get("error", "Unknown error occurred")
    
    # Send error email
    result = {
        "to": recipients,
        "from": from_email,
        "subject": "❌ Agentic AI Analysis Failed",
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
            <h1>❌ Agentic AI Analysis Failed</h1>
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
    document_title = analysis_data.get("document_title", "Untitled")
    ai_analysis = analysis_data.get("ai_analysis", "<p>No analysis available</p>")
    analysis_focus = analysis_data.get("analysis_focus", "general")
    summary_length = analysis_data.get("summary_length", "standard")
    model_used = analysis_data.get("model_used", "Unknown")
    usage_stats = analysis_data.get("usage_stats", {})
    content_length = analysis_data.get("extracted_content_length", 0)
    processed_at = analysis_data.get("processed_at", "Unknown")
    custom_instructions = analysis_data.get("custom_instructions", "None")
    
    subject = f"🤖 Agentic AI Analysis Complete: {document_title}"
    
    # Create HTML email with agentic AI analysis
    html_body = f'''
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {{ font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }}
        .container {{ max-width: 800px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }}
        .header {{ background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }}
        .header h1 {{ margin: 0; font-size: 26px; font-weight: 400; }}
        .header .badge {{ background: rgba(255,255,255,0.2); padding: 8px 16px; border-radius: 20px; font-size: 14px; margin-top: 10px; display: inline-block; }}
        .content {{ padding: 30px; }}
        .file-info {{ background: #e8f4fd; padding: 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #007bff; }}
        .analysis-config {{ background: #fff3cd; padding: 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #ffc107; }}
        .custom-instructions {{ background: #d1ecf1; padding: 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #17a2b8; }}
        .analysis-box {{ background: #f8f9fa; padding: 25px; border-radius: 8px; border: 1px solid #dee2e6; margin-bottom: 25px; }}
        .analysis-content {{ color: #2c3e50; line-height: 1.8; }}
        .stats {{ display: flex; justify-content: space-around; background: #e9ecef; padding: 20px; border-radius: 8px; margin: 20px 0; }}
        .stat {{ text-align: center; }}
        .stat-number {{ font-size: 20px; font-weight: bold; color: #667eea; }}
        .footer {{ background: #1f2937; color: white; padding: 20px; text-align: center; font-size: 14px; }}
        .agentic-badge {{ background: linear-gradient(45deg, #667eea, #764ba2); color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: bold; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Agentic AI Analysis Complete</h1>
            <div class="badge">Powered by {model_used} • <span class="agentic-badge">AGENTIC AI</span></div>
        </div>
        
        <div class="content">
            <div class="file-info">
                <strong>📄 Document:</strong> {document_title}<br>
                <strong>📁 File:</strong> {file_name}<br>
                <strong>🤖 AI Model:</strong> {model_used} (Agentic Mode)<br>
                <strong>📊 Content Length:</strong> {content_length:,} characters<br>
                <strong>⏰ Processed:</strong> {processed_at}
            </div>

            <div class="analysis-config">
                <h3 style="color: #856404; margin-top: 0;">⚙️ Analysis Configuration:</h3>
                <strong>🎯 Focus:</strong> {analysis_focus.replace('_', ' ').title()}<br>
                <strong>📏 Length:</strong> {summary_length.title()}<br>
                <strong>🧠 Approach:</strong> Agentic AI with Advanced Reasoning
            </div>

            {f'''
            <div class="custom-instructions">
                <h3 style="color: #0c5460; margin-top: 0;">📝 Custom Instructions:</h3>
                <div style="font-style: italic;">{custom_instructions}</div>
            </div>
            ''' if custom_instructions and custom_instructions.strip() else ''}

            <div class="stats">
                <div class="stat">
                    <div class="stat-number">🤖</div>
                    <div>Agentic AI</div>
                </div>
                <div class="stat">
                    <div class="stat-number">{usage_stats.get('totalTokenCount', 'N/A')}</div>
                    <div>Tokens</div>
                </div>
                <div class="stat">
                    <div class="stat-number">🧠</div>
                    <div>Reasoning</div>
                </div>
                <div class="stat">
                    <div class="stat-number">📊</div>
                    <div>Structured</div>
                </div>
            </div>

            <div class="analysis-box">
                <h3 style="color: #667eea; margin-top: 0;">🧠 Agentic AI Analysis Results:</h3>
                <div class="analysis-content">{ai_analysis}</div>
            </div>
        </div>
        
        <div class="footer">
            🤖 Agentic AI Analysis • Advanced Reasoning • Powered by {model_used} • HTML Formatted Output
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
          recipients: ["yash.daga@juspay.in", "aman.asrani@juspay.in"],
          from_email: "aman.asrani@juspay.in",
          content_type: "html",
          template_type: "agentic_ai_results",
        },
        createdBy: "system",
      })
      .returning()

    console.log("Created email tool:", emailTool.id)

    // 5. Create workflow steps
    // Step 1: Document Upload (manual)
    const [step1] = await db
      .insert(workflowStepTemplate)
      .values({
        workflowTemplateId: workflowTemplateResult.id,
        name: "Document Upload",
        description: "Upload document and configure analysis settings",
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
            "Upload your document and configure the agentic AI analysis settings",
        },
      })
      .returning()

    console.log("Created step 1:", step1.id)

    // Step 2: Agentic AI Analysis (automated)
    const [step2] = await db
      .insert(workflowStepTemplate)
      .values({
        workflowTemplateId: workflowTemplateResult.id,
        name: "Agentic AI Analysis",
        description:
          "Analyze document using agentic AI with advanced reasoning",
        type: "automated",
        parentStepId: null,
        prevStepIds: [],
        nextStepIds: [],
        toolIds: [agenticAiTool.id],
        timeEstimate: 300,
        metadata: {
          icon: "🤖",
          step_order: 2,
          automated_description:
            "Processing document with agentic AI and advanced reasoning capabilities",
          agentic_ai: true,
        },
      })
      .returning()

    console.log("Created step 2:", step2.id)

    // Step 3: Email Results (automated)
    const [step3] = await db
      .insert(workflowStepTemplate)
      .values({
        workflowTemplateId: workflowTemplateResult.id,
        name: "Email Results",
        description: "Send agentic AI analysis results via email",
        type: "automated",
        parentStepId: null,
        prevStepIds: [],
        nextStepIds: [],
        toolIds: [emailTool.id],
        timeEstimate: 30,
        metadata: {
          icon: "📧",
          step_order: 3,
          automated_description:
            "Sending agentic AI analysis results to recipients",
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

    console.log("✅ Successfully created Agentic AI workflow template!")
    console.log("Template ID:", workflowTemplateResult.id)
    console.log("Root Step ID:", step1.id)
    console.log("Steps created: 3")
    console.log("Tools created: 3")

    return {
      templateId: workflowTemplateResult.id,
      rootStepId: step1.id,
      tools: {
        form: formTool.id,
        agenticAi: agenticAiTool.id,
        email: emailTool.id,
      },
      steps: {
        upload: step1.id,
        analysis: step2.id,
        email: step3.id,
      },
    }
  } catch (error) {
    console.error("Error creating Agentic AI workflow:", error)
    throw error
  }
}

createAgenticAIWorkflow()
  .then((result) => {
    console.log("Agentic AI workflow creation completed:", result)
    process.exit(0)
  })
  .catch((error) => {
    console.error("Failed to create Agentic AI workflow:", error)
    process.exit(1)
  })
