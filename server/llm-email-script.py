import json
from datetime import datetime

# Get data from previous steps
analysis_data = previous_step_results.get("LLM Content Analysis", {}).get("result", {})

if analysis_data.get("status") != "success":
    error_msg = analysis_data.get("error", "Unknown error occurred")
    
    result = {
        "to": "avirupsinha10@gmail.com",
        "subject": "❌ LLM Analysis Failed",
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
            <h1>❌ LLM Analysis Failed</h1>
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
    llm_analysis = analysis_data.get("llm_analysis", "No analysis available")
    model_used = analysis_data.get("model_used", "Unknown")
    tokens_used = analysis_data.get("tokens_used", "Unknown")
    content_length = analysis_data.get("extracted_content_length", 0)
    processed_at = analysis_data.get("processed_at", "Unknown")
    
    subject = f"🤖 LLM Analysis: {file_name}"
    
    # Create HTML email with LLM analysis
    html_body = f'''
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {{ font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }}
        .container {{ max-width: 700px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }}
        .header {{ background: linear-gradient(135deg, #6f42c1 0%, #5a32a3 100%); color: white; padding: 30px; text-align: center; }}
        .header h1 {{ margin: 0; font-size: 24px; font-weight: 400; }}
        .header .badge {{ background: rgba(255,255,255,0.2); padding: 5px 15px; border-radius: 20px; font-size: 14px; margin-top: 10px; display: inline-block; }}
        .content {{ padding: 30px; }}
        .file-info {{ background: #e7e3ff; padding: 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #6f42c1; }}
        .analysis-box {{ background: #f8f9fa; padding: 25px; border-radius: 8px; border: 1px solid #dee2e6; }}
        .analysis-content {{ color: #2c3e50; line-height: 1.8; white-space: pre-line; font-size: 15px; }}
        .stats {{ display: flex; justify-content: space-around; background: #e9ecef; padding: 15px; border-radius: 8px; margin: 20px 0; }}
        .stat {{ text-align: center; }}
        .stat-number {{ font-size: 18px; font-weight: bold; color: #6f42c1; }}
        .footer {{ background: #2c3e50; color: white; padding: 20px; text-align: center; font-size: 14px; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 LLM Document Analysis</h1>
            <div class="badge">AI-Powered Analysis</div>
        </div>
        
        <div class="content">
            <div class="file-info">
                <strong>📄 File:</strong> {file_name}<br>
                <strong>🤖 AI Model:</strong> {model_used}<br>
                <strong>🔢 Tokens Used:</strong> {tokens_used}<br>
                <strong>📊 Content Length:</strong> {content_length:,} characters<br>
                <strong>⏰ Processed:</strong> {processed_at}
            </div>

            <div class="stats">
                <div class="stat">
                    <div class="stat-number">🤖</div>
                    <div>LLM Analysis</div>
                </div>
                <div class="stat">
                    <div class="stat-number">{tokens_used}</div>
                    <div>Tokens</div>
                </div>
                <div class="stat">
                    <div class="stat-number">🔍</div>
                    <div>AI-Powered</div>
                </div>
            </div>

            <div class="analysis-box">
                <h3 style="color: #6f42c1; margin-top: 0;">🧠 AI Analysis Results:</h3>
                <div class="analysis-content">{llm_analysis}</div>
            </div>
        </div>
        
        <div class="footer">
            🤖 LLM Document Analysis • Powered by {model_used} • Real AI Processing
        </div>
    </div>
</body>
</html>
    '''

    result = {
        "to": "avirup.sinha@juspay.in",
        "subject": subject,
        "body": html_body,
        "content_type": "text/html"
    }