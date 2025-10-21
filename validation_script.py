#!/usr/bin/env python3

import json
import re
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Set, Tuple, Any
import difflib

class QueryValidationAnalyzer:
    def __init__(self, queries_file: str, thread_data_file: str):
        self.queries_file = queries_file
        self.thread_data_file = thread_data_file
        self.queries = []
        self.thread_data = []
        self.doc_index = {}  # docId -> document mapping
        self.content_index = {}  # docId -> concatenated content
        self.validation_results = []
        
    def load_data(self):
        """Load and parse the JSON files"""
        print("Loading data files...")
        
        # Load queries
        with open(self.queries_file, 'r', encoding='utf-8') as f:
            self.queries = json.load(f)
        print(f"Loaded {len(self.queries)} queries")
        
        # Load thread data
        with open(self.thread_data_file, 'r', encoding='utf-8') as f:
            self.thread_data = json.load(f)
        print(f"Loaded {len(self.thread_data)} thread data documents")
        
        # Build indices
        self._build_indices()
    
    def _build_indices(self):
        """Build indices for efficient lookup"""
        print("Building search indices...")
        
        for doc in self.thread_data:
            if 'fields' in doc:
                fields = doc['fields']
                doc_id = fields.get('docId', '')
                if doc_id:
                    self.doc_index[doc_id] = fields
                    
                    # Concatenate all textual content
                    content_parts = []
                    
                    # Add various text fields
                    for field in ['title', 'subject', 'chunks', 'owner', 'ownerEmail']:
                        if field in fields:
                            if isinstance(fields[field], list):
                                content_parts.extend([str(item) for item in fields[field]])
                            else:
                                content_parts.append(str(fields[field]))
                    
                    self.content_index[doc_id] = ' '.join(content_parts).lower()
    
    def extract_doc_ids_from_answer(self, answer: str) -> List[str]:
        """Extract document IDs referenced in the answer"""
        # Look for patterns like (docId: ...), (doc: ...), (email ...), etc.
        doc_id_patterns = [
            r'\(docId:\s*([a-f0-9]+)\)',
            r'\(doc:\s*([a-f0-9]+)\)',
            r'\(email\s+([a-f0-9]+)\)',
            r'\(file\s+([a-f0-9]+)\)',
            r'\(event\s+([a-f0-9]+)\)',
            r'\(slack\s+([a-f0-9]+)\)',
            r'docId:\s*([a-f0-9]+)',
            r'doc:\s*([a-f0-9]+)'
        ]
        
        doc_ids = set()
        for pattern in doc_id_patterns:
            matches = re.findall(pattern, answer, re.IGNORECASE)
            doc_ids.update(matches)
        
        # Also look for document IDs that might be mentioned without clear markers
        # Look for 32-character hex strings that could be document IDs
        hex_pattern = r'\b([a-f0-9]{20,})\b'
        potential_doc_ids = re.findall(hex_pattern, answer, re.IGNORECASE)
        for doc_id in potential_doc_ids:
            if doc_id in self.doc_index:
                doc_ids.add(doc_id)
        
        return list(doc_ids)
    
    def check_factual_accuracy(self, question: str, answer: str, referenced_doc_ids: List[str]) -> Dict[str, Any]:
        """Check if the answer facts are supported by the referenced documents"""
        accuracy_results = {
            'supported_facts': [],
            'unsupported_facts': [],
            'missing_references': [],
            'accuracy_score': 0.0,
            'confidence': 0.0
        }
        
        if not referenced_doc_ids:
            return {
                'supported_facts': [],
                'unsupported_facts': ['No document references found in answer'],
                'missing_references': [],
                'accuracy_score': 0.0,
                'confidence': 0.0
            }
        
        # Get content from referenced documents
        referenced_content = ""
        valid_doc_ids = []
        
        for doc_id in referenced_doc_ids:
            if doc_id in self.content_index:
                referenced_content += " " + self.content_index[doc_id]
                valid_doc_ids.append(doc_id)
            else:
                accuracy_results['missing_references'].append(f"Document {doc_id} not found in thread data")
        
        if not valid_doc_ids:
            accuracy_results['unsupported_facts'].append("None of the referenced documents exist in the thread data")
            return accuracy_results
        
        # Extract key claims from the answer
        key_claims = self._extract_key_claims(answer)
        
        supported_count = 0
        for claim in key_claims:
            if self._is_claim_supported(claim, referenced_content):
                accuracy_results['supported_facts'].append(claim)
                supported_count += 1
            else:
                accuracy_results['unsupported_facts'].append(claim)
        
        if key_claims:
            accuracy_results['accuracy_score'] = supported_count / len(key_claims)
        
        # Calculate confidence based on document availability and claim support
        doc_availability = len(valid_doc_ids) / len(referenced_doc_ids) if referenced_doc_ids else 0
        accuracy_results['confidence'] = (accuracy_results['accuracy_score'] + doc_availability) / 2
        
        return accuracy_results
    
    def _extract_key_claims(self, answer: str) -> List[str]:
        """Extract key factual claims from the answer"""
        # Split answer into sentences and filter out generic statements
        sentences = re.split(r'[.!?]+', answer)
        
        key_claims = []
        for sentence in sentences:
            sentence = sentence.strip()
            if len(sentence) < 20:  # Skip very short sentences
                continue
                
            # Look for sentences with specific details
            if any(indicator in sentence.lower() for indicator in [
                'jira', 'pay-', 'email', 'docid', 'error', 'api', 'endpoint',
                'latency', 'tps', 'failure', 'success', 'configuration',
                'percent', '%', 'ms', 'seconds', 'minutes', 'hours',
                'amount', 'inr', 'usd', 'transactions', 'users'
            ]):
                key_claims.append(sentence)
        
        return key_claims[:10]  # Limit to top 10 claims to avoid overwhelming analysis
    
    def _is_claim_supported(self, claim: str, referenced_content: str) -> bool:
        """Check if a specific claim is supported by the referenced content"""
        claim_lower = claim.lower()
        content_lower = referenced_content.lower()
        
        # Extract key terms from the claim
        key_terms = re.findall(r'\b\w{3,}\b', claim_lower)
        
        # Check how many key terms appear in the content
        found_terms = 0
        for term in key_terms:
            if term in content_lower:
                found_terms += 1
        
        # Consider claim supported if significant portion of key terms are found
        support_threshold = 0.3  # At least 30% of key terms should be found
        return (found_terms / len(key_terms)) >= support_threshold if key_terms else False
    
    def check_question_validity(self, question: str) -> Dict[str, Any]:
        """Check if the question can be answered using the available thread data"""
        question_lower = question.lower()
        
        # Extract key terms from question
        key_terms = re.findall(r'\b\w{3,}\b', question_lower)
        
        # Remove common words
        common_words = {'the', 'and', 'for', 'are', 'was', 'were', 'what', 'how', 'why', 'when', 'where', 'who', 'which', 'that', 'this', 'with', 'from', 'about', 'can', 'will', 'all', 'any', 'has', 'have', 'had', 'our', 'their', 'your', 'you'}
        key_terms = [term for term in key_terms if term not in common_words and len(term) > 2]
        
        # Check if key terms appear in thread data
        found_terms = 0
        total_docs_with_terms = 0
        
        for doc_id, content in self.content_index.items():
            doc_has_terms = False
            for term in key_terms:
                if term in content:
                    found_terms += 1
                    doc_has_terms = True
            if doc_has_terms:
                total_docs_with_terms += 1
        
        validity_score = (found_terms / len(key_terms)) if key_terms else 0
        
        return {
            'validity_score': validity_score,
            'key_terms': key_terms,
            'found_terms': found_terms,
            'total_terms': len(key_terms),
            'docs_with_relevant_content': total_docs_with_terms,
            'is_answerable': validity_score > 0.3 and total_docs_with_terms > 0
        }
    
    def check_for_hallucination(self, question: str, answer: str) -> Dict[str, Any]:
        """Check if the answer contains hallucinated information"""
        hallucination_results = {
            'potential_hallucinations': [],
            'confidence_score': 0.0,
            'risk_level': 'low'
        }
        
        # Extract specific claims that could be hallucinated
        specific_patterns = [
            (r'jira\s+pay-\d+', 'JIRA ticket numbers'),
            (r'\d+%', 'Percentage values'),
            (r'₹[\d,]+', 'Specific monetary amounts'),
            (r'\d+\.\d+\s*seconds?', 'Specific time measurements'),
            (r'\d+\s*tps', 'TPS values'),
            (r'error\s+code[:\s]+[\w\d-]+', 'Error codes'),
            (r'endpoint[:\s]+/[\w/]+', 'API endpoints'),
            (r'docid[:\s]+[a-f0-9]+', 'Document IDs')
        ]
        
        for pattern, description in specific_patterns:
            matches = re.findall(pattern, answer.lower())
            if matches:
                # Check if these specific values exist in thread data
                all_content = ' '.join(self.content_index.values()).lower()
                for match in matches:
                    if match not in all_content:
                        hallucination_results['potential_hallucinations'].append(
                            f"{description}: '{match}' not found in source data"
                        )
        
        # Calculate risk based on number of potential hallucinations
        num_hallucinations = len(hallucination_results['potential_hallucinations'])
        
        if num_hallucinations == 0:
            hallucination_results['risk_level'] = 'low'
            hallucination_results['confidence_score'] = 0.9
        elif num_hallucinations <= 2:
            hallucination_results['risk_level'] = 'medium'
            hallucination_results['confidence_score'] = 0.6
        else:
            hallucination_results['risk_level'] = 'high'
            hallucination_results['confidence_score'] = 0.3
        
        return hallucination_results
    
    def validate_all_queries(self):
        """Validate all questions and answers"""
        print("Starting validation of all queries...")
        print("="*80)
        
        for idx, query in enumerate(self.queries):
            if idx % 10 == 0:
                print(f"Processing query {idx + 1}/{len(self.queries)}...")
            
            question = query.get('Question', '')
            answer = query.get('Answer', '')
            user_id = query.get('User_data', {}).get('UserID', 'Unknown')
            
            # Extract referenced document IDs
            referenced_doc_ids = self.extract_doc_ids_from_answer(answer)
            
            # Perform validations
            question_validity = self.check_question_validity(question)
            factual_accuracy = self.check_factual_accuracy(question, answer, referenced_doc_ids)
            hallucination_check = self.check_for_hallucination(question, answer)
            
            validation_result = {
                'query_index': idx,
                'user_id': user_id,
                'question': question[:200] + '...' if len(question) > 200 else question,
                'answer_length': len(answer),
                'referenced_doc_ids': referenced_doc_ids,
                'question_validity': question_validity,
                'factual_accuracy': factual_accuracy,
                'hallucination_check': hallucination_check,
                'overall_score': self._calculate_overall_score(question_validity, factual_accuracy, hallucination_check)
            }
            
            self.validation_results.append(validation_result)
    
    def _calculate_overall_score(self, question_validity: Dict, factual_accuracy: Dict, hallucination_check: Dict) -> float:
        """Calculate an overall quality score for the query"""
        validity_score = question_validity['validity_score']
        accuracy_score = factual_accuracy['accuracy_score']
        hallucination_score = hallucination_check['confidence_score']
        
        # Weighted average
        return (validity_score * 0.3 + accuracy_score * 0.5 + hallucination_score * 0.2)
    
    def generate_report(self):
        """Generate a comprehensive validation report"""
        if not self.validation_results:
            print("No validation results available. Run validate_all_queries() first.")
            return
        
        print("\n" + "="*80)
        print("QUERY VALIDATION REPORT")
        print("="*80)
        print(f"Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"Total queries analyzed: {len(self.validation_results)}")
        print()
        
        # Overall statistics
        self._generate_overall_statistics()
        
        # Quality distribution
        self._generate_quality_distribution()
        
        # Top issues
        self._generate_top_issues()
        
        # Detailed findings
        self._generate_detailed_findings()
        
        # Recommendations
        self._generate_recommendations()
    
    def _generate_overall_statistics(self):
        """Generate overall statistics"""
        print("OVERALL STATISTICS:")
        print("-" * 40)
        
        # Calculate averages
        avg_overall_score = sum(r['overall_score'] for r in self.validation_results) / len(self.validation_results)
        avg_validity_score = sum(r['question_validity']['validity_score'] for r in self.validation_results) / len(self.validation_results)
        avg_accuracy_score = sum(r['factual_accuracy']['accuracy_score'] for r in self.validation_results) / len(self.validation_results)
        
        # Count high-risk hallucinations
        high_risk_hallucinations = sum(1 for r in self.validation_results if r['hallucination_check']['risk_level'] == 'high')
        medium_risk_hallucinations = sum(1 for r in self.validation_results if r['hallucination_check']['risk_level'] == 'medium')
        
        # Count unanswerable questions
        unanswerable_questions = sum(1 for r in self.validation_results if not r['question_validity']['is_answerable'])
        
        # Count queries with missing references
        missing_references = sum(1 for r in self.validation_results if not r['referenced_doc_ids'])
        
        print(f"• Average overall quality score: {avg_overall_score:.2f}/1.0")
        print(f"• Average question validity score: {avg_validity_score:.2f}/1.0")
        print(f"• Average factual accuracy score: {avg_accuracy_score:.2f}/1.0")
        print(f"• High-risk hallucinations: {high_risk_hallucinations} ({high_risk_hallucinations/len(self.validation_results)*100:.1f}%)")
        print(f"• Medium-risk hallucinations: {medium_risk_hallucinations} ({medium_risk_hallucinations/len(self.validation_results)*100:.1f}%)")
        print(f"• Unanswerable questions: {unanswerable_questions} ({unanswerable_questions/len(self.validation_results)*100:.1f}%)")
        print(f"• Queries with missing document references: {missing_references} ({missing_references/len(self.validation_results)*100:.1f}%)")
        print()
    
    def _generate_quality_distribution(self):
        """Generate quality score distribution"""
        print("QUALITY SCORE DISTRIBUTION:")
        print("-" * 40)
        
        score_ranges = {
            'Excellent (0.8-1.0)': 0,
            'Good (0.6-0.8)': 0,
            'Fair (0.4-0.6)': 0,
            'Poor (0.2-0.4)': 0,
            'Very Poor (0.0-0.2)': 0
        }
        
        for result in self.validation_results:
            score = result['overall_score']
            if score >= 0.8:
                score_ranges['Excellent (0.8-1.0)'] += 1
            elif score >= 0.6:
                score_ranges['Good (0.6-0.8)'] += 1
            elif score >= 0.4:
                score_ranges['Fair (0.4-0.6)'] += 1
            elif score >= 0.2:
                score_ranges['Poor (0.2-0.4)'] += 1
            else:
                score_ranges['Very Poor (0.0-0.2)'] += 1
        
        for range_name, count in score_ranges.items():
            percentage = (count / len(self.validation_results)) * 100
            print(f"• {range_name}: {count} queries ({percentage:.1f}%)")
        print()
    
    def _generate_top_issues(self):
        """Generate top issues found"""
        print("TOP ISSUES IDENTIFIED:")
        print("-" * 40)
        
        # Collect all issues
        all_hallucinations = []
        missing_docs = []
        unsupported_facts = []
        
        for result in self.validation_results:
            all_hallucinations.extend(result['hallucination_check']['potential_hallucinations'])
            missing_docs.extend(result['factual_accuracy']['missing_references'])
            unsupported_facts.extend(result['factual_accuracy']['unsupported_facts'])
        
        # Count occurrences
        hallucination_counts = defaultdict(int)
        for h in all_hallucinations:
            hallucination_counts[h] += 1
        
        print("Most Common Potential Hallucinations:")
        for hallucination, count in sorted(hallucination_counts.items(), key=lambda x: x[1], reverse=True)[:5]:
            print(f"  • {hallucination} ({count} occurrences)")
        
        print(f"\nTotal missing document references: {len(missing_docs)}")
        print(f"Total unsupported factual claims: {len(unsupported_facts)}")
        print()
    
    def _generate_detailed_findings(self):
        """Generate detailed findings for problematic queries"""
        print("DETAILED FINDINGS (Top 10 Problematic Queries):")
        print("-" * 40)
        
        # Sort by overall score (lowest first)
        problematic_queries = sorted(self.validation_results, key=lambda x: x['overall_score'])[:10]
        
        for i, result in enumerate(problematic_queries, 1):
            print(f"\n{i}. Query Index: {result['query_index']} | User: {result['user_id']}")
            print(f"   Overall Score: {result['overall_score']:.2f}")
            print(f"   Question: {result['question']}")
            
            # Question validity issues
            if not result['question_validity']['is_answerable']:
                print(f"   ⚠️  Question may not be answerable from available data")
                print(f"      Found {result['question_validity']['found_terms']}/{result['question_validity']['total_terms']} key terms")
            
            # Document reference issues
            if not result['referenced_doc_ids']:
                print(f"   ❌ No document references found in answer")
            elif result['factual_accuracy']['missing_references']:
                print(f"   ❌ Missing document references: {len(result['factual_accuracy']['missing_references'])}")
            
            # Hallucination issues
            if result['hallucination_check']['risk_level'] in ['medium', 'high']:
                print(f"   🚨 {result['hallucination_check']['risk_level'].upper()} risk of hallucination")
                for hallucination in result['hallucination_check']['potential_hallucinations'][:3]:
                    print(f"      • {hallucination}")
            
            # Accuracy issues
            if result['factual_accuracy']['accuracy_score'] < 0.5:
                print(f"   📊 Low factual accuracy: {result['factual_accuracy']['accuracy_score']:.2f}")
        print()
    
    def _generate_recommendations(self):
        """Generate recommendations for improvement"""
        print("RECOMMENDATIONS:")
        print("-" * 40)
        
        # Calculate statistics for recommendations
        high_risk_count = sum(1 for r in self.validation_results if r['hallucination_check']['risk_level'] == 'high')
        missing_refs_count = sum(1 for r in self.validation_results if not r['referenced_doc_ids'])
        low_accuracy_count = sum(1 for r in self.validation_results if r['factual_accuracy']['accuracy_score'] < 0.5)
        
        recommendations = []
        
        if high_risk_count > len(self.validation_results) * 0.1:  # More than 10%
            recommendations.append(
                f"🚨 HIGH PRIORITY: {high_risk_count} queries show high risk of hallucination. "
                "Review answer generation process to ensure all claims are grounded in source data."
            )
        
        if missing_refs_count > len(self.validation_results) * 0.2:  # More than 20%
            recommendations.append(
                f"📝 MEDIUM PRIORITY: {missing_refs_count} queries lack proper document references. "
                "Implement systematic citation of source documents in all generated answers."
            )
        
        if low_accuracy_count > len(self.validation_results) * 0.3:  # More than 30%
            recommendations.append(
                f"📊 MEDIUM PRIORITY: {low_accuracy_count} queries have low factual accuracy scores. "
                "Improve fact verification against source documents before finalizing answers."
            )
        
        recommendations.extend([
            "🔍 Implement automated fact-checking pipeline to verify claims against source data",
            "📚 Create comprehensive document indexing to improve answer-source alignment",
            "🎯 Add confidence scoring to highlight uncertain or potentially inaccurate answers",
            "📋 Regular quality audits with manual review of high-risk queries",
            "🔄 Continuous model improvement based on validation feedback"
        ])
        
        for i, rec in enumerate(recommendations, 1):
            print(f"{i}. {rec}")
        print()
    
    def save_detailed_results(self, output_file: str = "validation_results.json"):
        """Save detailed validation results to a JSON file"""
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(self.validation_results, f, indent=2, ensure_ascii=False)
        print(f"Detailed results saved to {output_file}")

def main():
    # Initialize the analyzer
    analyzer = QueryValidationAnalyzer(
        queries_file="/Users/telkar.varasree/Downloads/xyne/server/queries.json",
        thread_data_file="/Users/telkar.varasree/Downloads/xyne/server/threadId_data.json"
    )
    
    # Load data
    analyzer.load_data()
    
    # Validate all queries
    analyzer.validate_all_queries()
    
    # Generate report
    analyzer.generate_report()
    
    # Save detailed results
    analyzer.save_detailed_results("/Users/telkar.varasree/Downloads/xyne/validation_results.json")

if __name__ == "__main__":
    main()