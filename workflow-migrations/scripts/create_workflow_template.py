#!/usr/bin/env python3
"""
Python script to call the Xyne server's complex workflow template creation API.
This replicates the curl command to create a workflow template with multiple steps.
"""

import requests
import json
import sys
from datetime import datetime

# Configuration
API_BASE_URL = "http://localhost:3000"
ENDPOINT = "/api/v1/workflow/templates/complex"

# Authentication tokens (from your curl command)
ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhdmlydXAuc2luaGFAanVzcGF5LmluIiwicm9sZSI6IlVzZXIiLCJ3b3Jrc3BhY2VJZCI6ImRodms1czh4cXlib3drMGoxNDB4Z3o5aiIsInRva2VuVHlwZSI6ImFjY2VzcyIsImV4cCI6MTc1NzUwNTc5M30.UiGzNXb0bEiE9Fs25hm9DbCQSGvhe5XrY2gXE7qPEYk"
REFRESH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhdmlydXAuc2luaGFAanVzcGF5LmluIiwicm9sZSI6IlVzZXIiLCJ3b3Jrc3BhY2VJZCI6ImRodms1czh4cXlib3drMGoxNDB4Z3o5aiIsInRva2VuVHlwZSI6InJlZnJlc2giLCJleHAiOjE3NjAwOTQxOTN9.FCWyhiVLVPWMGlsNilchJdR64Lys-aZooqSPbxhvYl8"

def create_workflow_payload():
    """Create the workflow template payload matching the curl request."""
    return {
        "name": f"Custom Workflow {datetime.now().strftime('%d/%m/%Y')}",
        "description": "Workflow created from builder",
        "version": "1.0.0",
        "config": {
            "ai_model": "gemini-1.5-pro",
            "max_file_size": "10MB",
            "auto_execution": False,
            "schema_version": "1.0",
            "allowed_file_types": ["pdf", "docx", "txt", "jpg", "png"],
            "supports_file_upload": True
        },
        "nodes": [
            {
                "id": "form-submission",
                "type": "stepNode",
                "position": {"x": 400, "y": 100},
                "data": {
                    "step": {
                        "id": "form-submission",
                        "name": "Doc summariser Form",
                        "status": "PENDING",
                        "contents": [],
                        "type": "form_submission",
                        "config": {
                            "title": "Doc summariser Form",
                            "description": "Doc summariser Form",
                            "fields": [
                                {
                                    "id": "6c745a45-600d-4e84-936b-24a7283ee100",
                                    "name": "Field 1",
                                    "placeholder": "",
                                    "type": "file",
                                    "fileTypes": ["pdf", "doc", "docx", "txt", "jpg", "png"],
                                    "required": True
                                }
                            ]
                        }
                    },
                    "tools": [
                        {
                            "id": "tool-form-submission",
                            "type": "form",
                            "val": {
                                "title": "Doc summariser Form",
                                "description": "Doc summariser Form",
                                "fields": [
                                    {
                                        "id": "6c745a45-600d-4e84-936b-24a7283ee100",
                                        "name": "Field 1",
                                        "placeholder": "",
                                        "type": "file",
                                        "fileTypes": ["pdf", "doc", "docx", "txt", "jpg", "png"],
                                        "required": True
                                    }
                                ]
                            },
                            "value": {
                                "title": "Doc summariser Form",
                                "description": "Doc summariser Form",
                                "fields": [
                                    {
                                        "id": "6c745a45-600d-4e84-936b-24a7283ee100",
                                        "name": "Field 1",
                                        "placeholder": "",
                                        "type": "file",
                                        "fileTypes": ["pdf", "doc", "docx", "txt", "jpg", "png"],
                                        "required": True
                                    }
                                ]
                            },
                            "config": {
                                "title": "Doc summariser Form",
                                "description": "Doc summariser Form",
                                "fields": [
                                    {
                                        "id": "6c745a45-600d-4e84-936b-24a7283ee100",
                                        "name": "Field 1",
                                        "placeholder": "",
                                        "type": "file",
                                        "fileTypes": ["pdf", "doc", "docx", "txt", "jpg", "png"],
                                        "required": True
                                    }
                                ]
                            }
                        }
                    ],
                    "isActive": False,
                    "isCompleted": False,
                    "hasNext": False
                }
            },
            {
                "id": "step-2",
                "type": "stepNode",
                "position": {"x": 400, "y": 360},
                "data": {
                    "step": {
                        "id": "step-2",
                        "name": "AI Agent Document Summariser",
                        "description": "",
                        "type": "ai_agent",
                        "status": "pending",
                        "contents": [],
                        "config": {
                            "name": "AI Agent Document Summariser",
                            "description": "AI Agent to Summarise documents using gemini-1.5-pro",
                            "model": "gemini-1.5-pro",
                            "inputPrompt": "$json.input",
                            "systemPrompt": "AI Agent to Summarise documents",
                            "knowledgeBase": ""
                        }
                    },
                    "tools": [
                        {
                            "id": "tool-step-2",
                            "type": "ai_agent",
                            "val": {
                                "name": "AI Agent Document Summariser",
                                "description": "AI Agent to Summarise documents",
                                "model": "gemini-1.5-pro",
                                "inputPrompt": "$json.input",
                                "systemPrompt": "AI Agent to Summarise documents",
                                "knowledgeBase": ""
                            },
                            "value": {
                                "name": "AI Agent Document Summariser",
                                "description": "AI Agent to Summarise documents",
                                "model": "gemini-1.5-pro",
                                "inputPrompt": "$json.input",
                                "systemPrompt": "AI Agent to Summarise documents",
                                "knowledgeBase": ""
                            },
                            "config": {
                                "model": "gemini-1.5-pro",
                                "name": "AI Agent Document Summariser",
                                "description": "AI Agent to Summarise documents using gemini-1.5-pro",
                                "to_email": []
                            }
                        }
                    ],
                    "isActive": False,
                    "isCompleted": False,
                    "hasNext": False
                }
            },
            {
                "id": "step-3",
                "type": "stepNode",
                "position": {"x": 400, "y": 610},
                "data": {
                    "step": {
                        "id": "step-3",
                        "name": "Email",
                        "description": "",
                        "type": "email",
                        "status": "pending",
                        "contents": [],
                        "config": {
                            "sendingFrom": "aman.asrani@juspay.in",
                            "emailAddresses": ["avirupsinha10@gmail.com", "debajyoti.das@juspay.in"]
                        }
                    },
                    "tools": [
                        {
                            "id": "tool-step-3",
                            "type": "email",
                            "val": {
                                "sendingFrom": "aman.asrani@juspay.in",
                                "emailAddresses": ["avirupsinha10@gmail.com", "debajyoti.das@juspay.in"]
                            },
                            "value": {
                                "sendingFrom": "aman.asrani@juspay.in",
                                "emailAddresses": ["avirupsinha10@gmail.com", "debajyoti.das@juspay.in"]
                            },
                            "config": {
                                "to_email": ["avirupsinha10@gmail.com", "debajyoti.das@juspay.in"],
                                "from_email": "aman.asrani@juspay.in",
                                "sendingFrom": "aman.asrani@juspay.in",
                                "emailAddresses": ["avirupsinha10@gmail.com", "debajyoti.das@juspay.in"]
                            }
                        }
                    ],
                    "isActive": False,
                    "isCompleted": False,
                    "hasNext": True
                }
            }
        ],
        "edges": [
            {
                "id": "form-submission-step-2",
                "source": "form-submission",
                "target": "step-2",
                "type": "straight",
                "sourceHandle": "bottom",
                "targetHandle": "top",
                "style": {"stroke": "#D1D5DB", "strokeWidth": 2},
                "markerEnd": {"type": "arrowclosed", "color": "#D1D5DB"}
            },
            {
                "id": "step-2-step-3",
                "source": "step-2",
                "target": "step-3",
                "type": "straight",
                "sourceHandle": "bottom",
                "targetHandle": "top",
                "style": {"stroke": "#D1D5DB", "strokeWidth": 2},
                "markerEnd": {"type": "arrowclosed", "color": "#D1D5DB"}
            }
        ],
        "metadata": {
            "nodeCount": 3,
            "edgeCount": 2,
            "createdAt": datetime.now().isoformat() + "Z",
            "workflowType": "user-created"
        }
    }

def make_api_request():
    """Make the API request to create the complex workflow template."""
    url = f"{API_BASE_URL}{ENDPOINT}"
    
    # Headers from curl command
    headers = {
        'Accept': '*/*',
        'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'Referer': 'http://localhost:5173/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'Access-Control-Allow-Origin': '*'
    }
    
    # Cookies from curl command
    cookies = {
        'access-token': ACCESS_TOKEN,
        'refresh-token': REFRESH_TOKEN
    }
    
    # Create payload
    payload = create_workflow_payload()
    
    print(f"🚀 Making API request to: {url}")
    print(f"📦 Payload size: {len(json.dumps(payload))} characters")
    print(f"🔗 Nodes: {len(payload['nodes'])}, Edges: {len(payload['edges'])}")
    
    try:
        response = requests.post(
            url, 
            headers=headers, 
            cookies=cookies, 
            json=payload,
            timeout=30
        )
        
        print(f"📡 Response Status: {response.status_code}")
        print(f"📡 Response Headers: {dict(response.headers)}")
        
        if response.status_code == 200:
            result = response.json()
            print("✅ Workflow template created successfully!")
            print(f"📋 Template ID: {result.get('data', {}).get('id', 'N/A')}")
            print(f"📝 Template Name: {result.get('data', {}).get('name', 'N/A')}")
            print(f"🔧 Steps Created: {len(result.get('data', {}).get('steps', []))}")
            print(f"⚙️ Tools Created: {len(result.get('data', {}).get('workflow_tools', []))}")
            
            return True, result
            
        else:
            print(f"❌ API request failed with status {response.status_code}")
            try:
                error_data = response.json()
                print(f"💥 Error details: {json.dumps(error_data, indent=2)}")
            except:
                print(f"💥 Error response: {response.text}")
            
            return False, None
            
    except requests.exceptions.RequestException as e:
        print(f"🔌 Network error: {e}")
        return False, None
    except json.JSONDecodeError as e:
        print(f"📄 JSON decode error: {e}")
        return False, None
    except Exception as e:
        print(f"💥 Unexpected error: {e}")
        return False, None

def test_server_health():
    """Test if the server is running by checking workflow templates endpoint."""
    try:
        # Test with a simple workflow templates list request
        test_url = f"{API_BASE_URL}/api/v1/workflow/templates"
        cookies = {'access-token': ACCESS_TOKEN}
        headers = {'Content-Type': 'application/json'}
        
        response = requests.get(test_url, headers=headers, cookies=cookies, timeout=5)
        if response.status_code == 200:
            print("✅ Server is running and accessible")
            return True
        else:
            print(f"⚠️ Server responded with status {response.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        print("❌ Cannot connect to server. Is it running on http://localhost:3000?")
        return False
    except Exception as e:
        print(f"❌ Server connectivity test failed: {e}")
        return False

def main():
    """Main function to execute the workflow creation."""
    print("🔬 Xyne Workflow Template Creator")
    print("=" * 50)
    
    # Test server connectivity
    print("🔍 Checking server health...")
    if not test_server_health():
        print("\n💡 Make sure the Xyne server is running:")
        print("   cd server && npm run dev")
        sys.exit(1)
    
    print("\n🏗️ Creating workflow template...")
    success, result = make_api_request()
    
    if success:
        print("\n🎉 Workflow creation completed successfully!")
        if result and 'data' in result:
            template_data = result['data']
            print(f"\n📊 Summary:")
            print(f"   • Template ID: {template_data.get('id')}")
            print(f"   • Root Step ID: {template_data.get('rootWorkflowStepTemplateId')}")
            print(f"   • Total Steps: {len(template_data.get('steps', []))}")
            print(f"   • Total Tools: {len(template_data.get('workflow_tools', []))}")
            
            # Save response to file for inspection
            with open('workflow_creation_response.json', 'w') as f:
                json.dump(result, f, indent=2)
            print(f"\n💾 Full response saved to: workflow_creation_response.json")
    else:
        print("\n💔 Workflow creation failed!")
        sys.exit(1)

if __name__ == "__main__":
    main()