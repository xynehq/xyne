#!/usr/bin/env python3
"""Test script for document parsing API."""

import sys
import json
import requests
import mimetypes
from pathlib import Path

API_URL = "http://localhost:8000/parse"


def test_file(filepath: str):
    """Test parsing a single file."""
    path = Path(filepath)
    
    if not path.exists():
        print(f"❌ File not found: {filepath}")
        return
    
    print(f"\n📄 Testing: {path.name}")
    print(f"   Size: {path.stat().st_size / 1024:.1f} KB")
    
    # Detect the correct MIME type based on file extension
    mime_type, _ = mimetypes.guess_type(str(path))
    if mime_type is None:
        mime_type = 'application/octet-stream'
    
    with open(path, 'rb') as f:
        files = {'file': (path.name, f, mime_type)}
        
        try:
            # Increased timeout for Docling model loading on first run
            response = requests.post(API_URL, files=files, timeout=300)
            
            if response.status_code == 200:
                data = response.json()
                print(f"✅ Success!")
                
                # Save output
                output_file = path.with_suffix('.parsed.json')
                with open(output_file, 'w') as out:
                    json.dump(data, out, indent=2)
                print(f"   Output saved: {output_file}")
                
                # Show structure preview
                doc = data.get('document', {})
                if 'texts' in doc:
                    print(f"   Texts: {len(doc['texts'])} items")
                if 'tables' in doc:
                    print(f"   Tables: {len(doc['tables'])} items")
                
            else:
                print(f"❌ Error {response.status_code}: {response.text}")
                
        except requests.exceptions.Timeout:
            print(f"⏱️  Request timed out (this is normal on first run - Docling downloads models)")
            print(f"   The server is still processing. Check server logs for progress.")
            print(f"   Try again in 2-3 minutes after models are cached.")
        except requests.exceptions.ConnectionError:
            print(f"❌ Cannot connect to {API_URL}")
            print("   Is the server running? (uvicorn app.main:app --reload)")
        except Exception as e:
            print(f"❌ Error: {e}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test_parse.py <file1.pdf> [file2.pdf] ...")
        print("\nExample:")
        print("  python test_parse.py ~/Documents/sample.pdf")
        sys.exit(1)
    
    for filepath in sys.argv[1:]:
        test_file(filepath)
