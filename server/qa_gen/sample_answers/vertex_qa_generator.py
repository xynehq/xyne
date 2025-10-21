import json
import time
import os
from typing import Dict, Any, List
import requests
from google.auth.transport.requests import Request
from google.oauth2 import service_account
import google.auth
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

class VertexAIQAGenerator:
    def __init__(self, project_id: str = None, location: str = None, model: str = None):
        """
        Initialize the Vertex AI QA Generator
        
        Args:
            project_id: Google Cloud Project ID
            location: Vertex AI location/region
            model: Vertex AI model to use for generation
        """
        self.project_id = project_id or os.getenv('VERTEX_PROJECT_ID')
        self.location = location or os.getenv('VERTEX_REGION', 'us-central1')
        self.model = model or os.getenv('VERTEX_AI_MODEL', 'gemini-2.5-pro')
        self.credentials = None
        
        # Initialize authentication
        self._setup_auth()
        
        if not self.project_id:
            raise ValueError("No project ID provided. Please set VERTEX_PROJECT_ID in your .env file or pass project_id parameter.")
    
    def _setup_auth(self):
        """Setup Google Cloud authentication"""
        try:
            # Try to get default credentials (works in Google Cloud environment)
            self.credentials, project = google.auth.default()
            if not self.project_id:
                self.project_id = project
            print(f"Using default credentials for project: {self.project_id}")
        except Exception as e:
            print(f"Could not get default credentials: {e}")
            
            # Try to use service account key file
            service_account_path = os.getenv('GOOGLE_APPLICATION_CREDENTIALS')
            if service_account_path and os.path.exists(service_account_path):
                try:
                    self.credentials = service_account.Credentials.from_service_account_file(
                        service_account_path,
                        scopes=['https://www.googleapis.com/auth/cloud-platform']
                    )
                    print(f"Using service account credentials from: {service_account_path}")
                except Exception as e:
                    print(f"Could not load service account credentials: {e}")
            else:
                print("Warning: No authentication credentials found. Please set up Google Cloud authentication.")
    
    def _get_access_token(self):
        """Get access token for API calls"""
        if not self.credentials:
            return None
        
        try:
            if not self.credentials.valid:
                self.credentials.refresh(Request())
            return self.credentials.token
        except Exception as e:
            print(f"Error getting access token: {e}")
            return None
    
    def create_prompt(self, email_data: Dict[str, Any]) -> str:
        """
        Create a prompt for Vertex AI to analyze the email and generate Q&A
        
        Args:
            email_data: Email data from JSONL
            
        Returns:
            Formatted prompt string
        """
        chunks = email_data.get('fields', {}).get('chunks', [])
        subject = email_data.get('fields', {}).get('subject', '')
        from_email = email_data.get('fields', {}).get('from', '')
        to_emails = email_data.get('fields', {}).get('to', [])
        
        # Combine all chunks into email content
        email_content = ' '.join(chunks)
        
        prompt = f"""
You are an expert at analyzing business emails and creating diverse, meaningful questions and answers.

Please analyze the following email and create ONE focused question and answer pair based on its content.

EMAIL DETAILS:
Subject: {subject}
From: {from_email}
To: {', '.join(to_emails)}

EMAIL CONTENT:
{email_content}

INSTRUCTIONS:
1. Read and understand the email content carefully
2. Identify ONE key aspect, issue, or topic from this email
3. Create a single, focused question (avoid compound questions with "and what")
4. Vary your question style - use different question types and starters

QUESTION VARIETY GUIDELINES:
- Use diverse question starters: "How", "Why", "Which", "When", "Who", "Where", "Can you explain"
- Avoid repetitive patterns like "What specific..." or "What is the..." or any other similar patterns
- Focus on single concepts rather than multiple parts
- Ask about outcomes, processes, decisions, timelines, people, or technical details
- Keep questions concise and specific to this email

Your response should be in JSON format only:
{{
    "query": "Your generated question here",
    "answer": "Your comprehensive answer here"
}}

Examples of good question variety only for reference (do NOT include in your response):
- "How did the team resolve the payment gateway timeout issue?"
- "Why was the merchant onboarding process delayed?"
- "Which compliance requirements were not met in the audit?"
- "When is the expected deadline for the API integration?"
- "Who is responsible for implementing the security patch?"
"""
        return prompt
    
    def call_vertex_ai(self, prompt: str, max_retries: int = 3) -> Dict[str, str]:
        """
        Call Vertex AI API to generate Q&A pair with retry mechanism
        
        Args:
            prompt: The prompt to send to Vertex AI
            max_retries: Maximum number of retry attempts
            
        Returns:
            Dictionary with query and answer
        """
        if not self.credentials or not self.project_id:
            raise ValueError("Missing credentials or project ID. Please check your .env file configuration.")
        
        for attempt in range(max_retries + 1):
            try:
                access_token = self._get_access_token()
                if not access_token:
                    raise ValueError("Could not get access token. Please check your authentication setup.")
                
                # Vertex AI API endpoint for Gemini models
                url = f"https://{self.location}-aiplatform.googleapis.com/v1/projects/{self.project_id}/locations/{self.location}/publishers/google/models/{self.model}:generateContent"
                
                headers = {
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json"
                }
                
                # Vertex AI request format for Gemini
                data = {
                    "contents": [
                        {
                            "role": "user",
                            "parts": [
                                {
                                    "text": prompt
                                }
                            ]
                        }
                    ],
                    "generationConfig": {
                        "temperature": 0.7,
                        "maxOutputTokens": 5000,
                        "topP": 0.8,
                        "topK": 40
                    }
                }
                
                response = requests.post(url, headers=headers, json=data, timeout=30)
                response.raise_for_status()
                result = response.json()
                
                # Parse Vertex AI Gemini response
                if 'candidates' in result and len(result['candidates']) > 0:
                    candidate = result['candidates'][0]
                    
                    # Check finish reason
                    finish_reason = candidate.get('finishReason', '')
                    if finish_reason == 'MAX_TOKENS':
                        raise ValueError("Model response was truncated due to token limit. Try reducing prompt length or increasing maxOutputTokens.")
                    
                    if 'content' in candidate:
                        # Check if parts exist (normal response structure)
                        if 'parts' in candidate['content'] and len(candidate['content']['parts']) > 0:
                            content = candidate['content']['parts'][0]['text'].strip()
                            
                            try:
                                # Parse the JSON response
                                qa_pair = json.loads(content)
                                return {
                                    "query": qa_pair.get("query", ""),
                                    "answer": qa_pair.get("answer", "")
                                }
                            except json.JSONDecodeError as e:
                                print(f"⚠️  JSON parsing failed, trying to extract from markdown...")
                                
                                # Try to extract JSON from markdown code blocks if present
                                if "```json" in content:
                                    start = content.find("```json") + 7
                                    end = content.find("```", start)
                                    if end != -1:
                                        json_content = content[start:end].strip()
                                        try:
                                            qa_pair = json.loads(json_content)
                                            print("✅ Successfully extracted JSON from markdown")
                                            return {
                                                "query": qa_pair.get("query", ""),
                                                "answer": qa_pair.get("answer", "")
                                            }
                                        except json.JSONDecodeError:
                                            pass
                                
                                print(f"❌ Failed to parse JSON response")
                                raise ValueError(f"Failed to parse JSON response: {content}")
                        else:
                            raise ValueError(f"No 'parts' found in content. Finish reason: {finish_reason}")
                    else:
                        raise ValueError(f"No 'content' found in candidate. Finish reason: {finish_reason}")
                
                raise ValueError(f"No candidates found in response: {result}")
                
            except (requests.exceptions.RequestException, 
                    requests.exceptions.Timeout, 
                    requests.exceptions.ConnectionError) as e:
                
                if attempt < max_retries:
                    # Calculate exponential backoff delay
                    delay = 2 ** attempt  # 1, 2, 4 seconds
                    print(f"Attempt {attempt + 1} failed: {str(e)}")
                    print(f"Retrying in {delay} seconds...")
                    time.sleep(delay)
                    
                    # Refresh access token on auth-related errors
                    if "401" in str(e) or "403" in str(e):
                        print("Refreshing access token...")
                        self.credentials = None
                        self._setup_auth()
                else:
                    print(f"Max retries ({max_retries}) exceeded. Final error: {str(e)}")
                    raise e
            
            except Exception as e:
                # For non-retryable errors, raise immediately
                print(f"Non-retryable error: {str(e)}")
                raise e
    
    
    def process_email_file(self, input_file: str, output_file: str, start_from: int = 0) -> None:
        """
        Process all emails in the JSONL file and generate Q&A pairs
        
        Args:
            input_file: Path to input JSONL file
            output_file: Path to output JSON file
            start_from: Index to start processing from (0-based)
        """
        # Load existing QA pairs if output file exists
        qa_pairs = []
        if os.path.exists(output_file):
            try:
                with open(output_file, 'r', encoding='utf-8') as f:
                    qa_pairs = json.load(f)
                print(f"Loaded {len(qa_pairs)} existing QA pairs from '{output_file}'")
            except Exception as e:
                print(f"Warning: Could not load existing QA pairs: {e}")
                qa_pairs = []
        
        try:
            with open(input_file, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            
            total_emails = len(lines)
            remaining_emails = total_emails - start_from
            print(f"Processing {remaining_emails} emails (starting from email {start_from + 1}/{total_emails}) with Vertex AI...")
            
            # Process emails starting from the specified index
            for i, line in enumerate(lines[start_from:], start_from + 1):
                try:
                    email_data = json.loads(line.strip())
                    
                    print(f"Processing email {i}/{total_emails}")
                    
                    # Create prompt for this email
                    prompt = self.create_prompt(email_data)
                    
                    # Generate Q&A pair using Vertex AI
                    qa_pair = self.call_vertex_ai(prompt)
                    
                    if qa_pair["query"] and qa_pair["answer"]:
                        qa_pairs.append(qa_pair)
                        
                        # Show the generated Q&A pair
                        print(f"✅ Generated QA pair #{len(qa_pairs)}:")
                        print(f"   Q: {qa_pair['query']}")
                        print(f"   A: {qa_pair['answer'][:150]}{'...' if len(qa_pair['answer']) > 150 else ''}")
                        print("-" * 80)
                        
                        # Save every 10 entries
                        if len(qa_pairs) % 10 == 0:
                            self._save_qa_pairs(qa_pairs, output_file)
                            print(f"💾 Saved progress: {len(qa_pairs)} QA pairs")
                            print("=" * 80)
                    else:
                        print(f"⚠️  Warning: Empty Q&A pair generated for email {i}")
                    
                    # Add small delay to respect API rate limits
                    if self.credentials:
                        time.sleep(0.5)
                    
                except json.JSONDecodeError as e:
                    print(f"Error parsing email {i}: {e}")
                    continue
                except Exception as e:
                    print(f"Error processing email {i}: {e}")
                    continue
            
            # Final save
            self._save_qa_pairs(qa_pairs, output_file)
            print(f"\nCompleted! Generated {len(qa_pairs)} total query/answer pairs and saved to '{output_file}'")
            
        except FileNotFoundError:
            print(f"Error: Input file '{input_file}' not found.")
        except Exception as e:
            print(f"Error processing file: {e}")
    
    def _save_qa_pairs(self, qa_pairs: List[Dict[str, str]], output_file: str) -> None:
        """
        Save QA pairs to output file
        
        Args:
            qa_pairs: List of QA pair dictionaries
            output_file: Path to output JSON file
        """
        try:
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump(qa_pairs, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Error saving QA pairs: {e}")

def main():
    """
    Main function to run the Vertex AI QA Generator
    """
    # Initialize the generator
    # You can set your Google Cloud Project ID as an environment variable or pass it directly
    generator = VertexAIQAGenerator()
    
    # Process the email file
    input_file = "email_latest.jsonl"
    output_file = "vertex_generated_qa_pairs.json"
    
    # Auto-detect where to resume processing
    start_from = 0
    if os.path.exists(output_file):
        try:
            with open(output_file, 'r', encoding='utf-8') as f:
                existing_qa_pairs = json.load(f)
            start_from = len(existing_qa_pairs)
            print(f"Found {start_from} existing QA pairs. Resuming from email {start_from + 1}")
        except Exception as e:
            print(f"Warning: Could not read existing QA pairs, starting from beginning: {e}")
            start_from = 0
    else:
        print("No existing QA pairs file found. Starting from the beginning.")
    
    # Check total emails to process
    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            total_emails = len(f.readlines())
        
        if start_from >= total_emails:
            print(f"All {total_emails} emails have already been processed!")
            return
        else:
            remaining = total_emails - start_from
            print(f"Will process {remaining} remaining emails out of {total_emails} total emails")
    except FileNotFoundError:
        print(f"Error: Input file '{input_file}' not found.")
        return
    
    generator.process_email_file(input_file, output_file, start_from=start_from)

if __name__ == "__main__":
    main()
