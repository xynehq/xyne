#!/usr/bin/env python3

import json
import re
from collections import defaultdict, Counter
from typing import Dict, List, Set, Tuple, Any
import difflib
from datetime import datetime

class KeywordBasedValidationAnalyzer:
    def __init__(self, queries_file: str, thread_data_file: str):
        self.queries_file = queries_file
        self.thread_data_file = thread_data_file
        self.queries = []
        self.thread_data = []
        self.all_content = ""  # Combined content from all thread data
        self.content_by_doc = {}  # docId -> content mapping
        self.keyword_index = defaultdict(set)  # keyword -> set of doc_ids
        self.validation_results = []
        
    def load_data(self):
        """Load and parse the JSON files"""
        print("Loading data files...")
        
        with open(self.queries_file, 'r', encoding='utf-8') as f:
            self.queries = json.load(f)
        print(f"Loaded {len(self.queries)} queries")
        
        with open(self.thread_data_file, 'r', encoding='utf-8') as f:
            self.thread_data = json.load(f)
        print(f"Loaded {len(self.thread_data)} thread data documents")
        
        self._build_content_index()
        self._build_keyword_index()
    
    def _build_content_index(self):
        """Build content index from thread data"""
        print("Building content index...")
        
        all_content_parts = []
        
        for doc in self.thread_data:
            if 'fields' in doc:
                fields = doc['fields']
                doc_id = fields.get('docId', '')
                
                # Extract all textual content
                content_parts = []
                
                # Add various text fields
                text_fields = ['title', 'subject', 'chunks', 'owner', 'ownerEmail', 'from', 'to']
                for field in text_fields:
                    if field in fields:
                        if isinstance(fields[field], list):
                            content_parts.extend([str(item) for item in fields[field]])
                        else:
                            content_parts.append(str(fields[field]))
                
                doc_content = ' '.join(content_parts)
                
                if doc_id:
                    self.content_by_doc[doc_id] = doc_content
                
                all_content_parts.append(doc_content)
        
        self.all_content = ' '.join(all_content_parts)
        print(f"Built content index with {len(self.content_by_doc)} documents")
        print(f"Total content length: {len(self.all_content):,} characters")
    
    def _build_keyword_index(self):
        """Build keyword index for faster lookups"""
        print("Building keyword index...")
        
        for doc_id, content in self.content_by_doc.items():
            # Extract meaningful keywords (3+ characters, alphanumeric)
            keywords = re.findall(r'\b\w{3,}\b', content.lower())
            
            for keyword in set(keywords):  # Use set to avoid duplicates
                self.keyword_index[keyword].add(doc_id)
        
        print(f"Built keyword index with {len(self.keyword_index)} unique keywords")
    
    def extract_meaningful_terms(self, text: str) -> List[str]:
        """Extract meaningful terms from text, filtering out common words"""
        # Common stop words to filter out
        stop_words = {
            'the', 'and', 'for', 'are', 'was', 'were', 'what', 'how', 'why', 'when', 
            'where', 'who', 'which', 'that', 'this', 'with', 'from', 'about', 'can', 
            'will', 'all', 'any', 'has', 'have', 'had', 'our', 'their', 'your', 'you', 
            'they', 'them', 'said', 'been', 'also', 'more', 'than', 'only', 'some', 
            'time', 'very', 'after', 'first', 'well', 'way', 'even', 'new', 'want', 
            'because', 'these', 'take', 'most', 'get', 'see', 'him', 'her', 'his', 
            'she', 'would', 'there', 'make', 'who', 'use', 'word', 'each', 'then', 
            'two', 'think', 'work', 'life', 'should', 'being', 'now', 'made', 'before', 
            'through', 'much', 'back', 'may', 'look', 'good', 'write', 'day', 'years',
            'based', 'according', 'regarding', 'related', 'issues', 'problem', 'problems'
        }
        
        # Extract words (3+ characters)
        words = re.findall(r'\b\w{3,}\b', text.lower())
        
        # Filter out stop words and very short words
        meaningful_terms = [word for word in words if word not in stop_words and len(word) >= 3]
        
        return meaningful_terms
    
    def calculate_keyword_coverage(self, question: str, answer: str) -> Dict[str, Any]:
        """Calculate how well the question and answer are covered by thread data"""
        question_terms = set(self.extract_meaningful_terms(question))
        answer_terms = set(self.extract_meaningful_terms(answer))
        
        # Combine question and answer terms
        all_terms = question_terms.union(answer_terms)
        
        if not all_terms:
            return {
                'total_terms': 0,
                'found_terms': 0,
                'coverage_score': 0.0,
                'missing_terms': [],
                'found_terms_list': [],
                'supporting_docs': []
            }
        
        # Check which terms are found in thread data
        found_terms = []
        missing_terms = []
        supporting_docs = set()
        
        all_content_lower = self.all_content.lower()
        
        for term in all_terms:
            if term in all_content_lower:
                found_terms.append(term)
                # Find which documents contain this term
                if term in self.keyword_index:
                    supporting_docs.update(self.keyword_index[term])
            else:
                missing_terms.append(term)
        
        coverage_score = len(found_terms) / len(all_terms) if all_terms else 0.0
        
        return {
            'total_terms': len(all_terms),
            'found_terms': len(found_terms),
            'coverage_score': coverage_score,
            'missing_terms': missing_terms,
            'found_terms_list': found_terms,
            'supporting_docs': list(supporting_docs)
        }
    
    def check_specific_claims(self, answer: str) -> Dict[str, Any]:
        """Check specific factual claims in the answer"""
        claims_analysis = {
            'jira_tickets': [],
            'error_codes': [],
            'api_endpoints': [],
            'specific_values': [],
            'person_names': [],
            'verified_claims': [],
            'unverified_claims': []
        }
        
        all_content_lower = self.all_content.lower()
        
        # Extract specific patterns
        patterns = {
            'jira_tickets': r'PAY-\d+',
            'error_codes': r'(?:error|code)[:\s]+[\w\d-]+',
            'api_endpoints': r'/[\w/.-]+',
            'specific_values': r'\d+(?:\.\d+)?%|\d+\s*(?:ms|tps|seconds?|minutes?)',
            'person_names': r'\b(?:Priya|Rohit|Arjun|Anjali|Aditya|Siddharth|Rohan|Anand)\s+\w+\b'
        }
        
        for pattern_name, pattern in patterns.items():
            matches = re.findall(pattern, answer, re.IGNORECASE)
            claims_analysis[pattern_name] = list(set(matches))  # Remove duplicates
            
            # Check if these claims are supported by thread data
            for match in set(matches):
                if match.lower() in all_content_lower or any(word in all_content_lower for word in match.lower().split()):
                    claims_analysis['verified_claims'].append(f"{pattern_name}: {match}")
                else:
                    claims_analysis['unverified_claims'].append(f"{pattern_name}: {match}")
        
        return claims_analysis
    
    def calculate_answer_quality_score(self, question: str, answer: str) -> Dict[str, Any]:
        """Calculate overall answer quality based on multiple factors"""
        coverage = self.calculate_keyword_coverage(question, answer)
        claims = self.check_specific_claims(answer)
        
        # Base score from keyword coverage
        quality_score = coverage['coverage_score']
        
        # Adjust based on specific claims verification
        total_specific_claims = len(claims['verified_claims']) + len(claims['unverified_claims'])
        if total_specific_claims > 0:
            claim_accuracy = len(claims['verified_claims']) / total_specific_claims
            # Weight claim accuracy heavily
            quality_score = (quality_score * 0.6) + (claim_accuracy * 0.4)
        
        # Penalty for having many unverified claims
        if len(claims['unverified_claims']) > 3:
            quality_score *= 0.8
        
        # Bonus for having supporting documents
        if len(coverage['supporting_docs']) > 0:
            quality_score = min(1.0, quality_score * 1.1)
        
        return {
            'overall_score': quality_score,
            'keyword_coverage': coverage,
            'claims_analysis': claims,
            'confidence_level': 'high' if quality_score >= 0.8 else 'medium' if quality_score >= 0.5 else 'low'
        }
    
    def validate_all_queries(self):
        """Validate all questions and answers using keyword-based approach"""
        print("\nStarting keyword-based validation of all queries...")
        print("="*80)
        
        for idx, query in enumerate(self.queries):
            if idx % 50 == 0:
                print(f"Processing query {idx + 1}/{len(self.queries)}...")
            
            question = query.get('Question', '')
            answer = query.get('Answer', '')
            user_id = query.get('User_data', {}).get('UserID', 'Unknown')
            
            # Calculate quality score
            quality_analysis = self.calculate_answer_quality_score(question, answer)
            
            validation_result = {
                'query_index': idx,
                'user_id': user_id,
                'question': question,
                'answer_length': len(answer),
                'quality_analysis': quality_analysis
            }
            
            self.validation_results.append(validation_result)
    
    def generate_comprehensive_report(self):
        """Generate a comprehensive validation report"""
        if not self.validation_results:
            print("No validation results available. Run validate_all_queries() first.")
            return
        
        print("\n" + "="*80)
        print("KEYWORD-BASED QUERY VALIDATION REPORT")
        print("="*80)
        print(f"Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"Total queries analyzed: {len(self.validation_results)}")
        print()
        
        self._generate_overall_statistics()
        self._generate_quality_distribution()
        self._generate_content_analysis()
        self._generate_problematic_queries()
        self._generate_recommendations()
    
    def _generate_overall_statistics(self):
        """Generate overall statistics"""
        print("OVERALL STATISTICS:")
        print("-" * 40)
        
        # Calculate averages
        total_scores = [r['quality_analysis']['overall_score'] for r in self.validation_results]
        avg_quality_score = sum(total_scores) / len(total_scores)
        
        coverage_scores = [r['quality_analysis']['keyword_coverage']['coverage_score'] for r in self.validation_results]
        avg_coverage = sum(coverage_scores) / len(coverage_scores)
        
        # Count confidence levels
        confidence_counts = Counter(r['quality_analysis']['confidence_level'] for r in self.validation_results)
        
        # Count queries with poor coverage
        poor_coverage = sum(1 for score in coverage_scores if score < 0.3)
        
        # Count queries with many unverified claims
        high_unverified = sum(1 for r in self.validation_results 
                            if len(r['quality_analysis']['claims_analysis']['unverified_claims']) > 3)
        
        print(f"• Average overall quality score: {avg_quality_score:.3f}/1.0")
        print(f"• Average keyword coverage: {avg_coverage:.3f}/1.0")
        print(f"• High confidence queries: {confidence_counts['high']} ({confidence_counts['high']/len(self.validation_results)*100:.1f}%)")
        print(f"• Medium confidence queries: {confidence_counts['medium']} ({confidence_counts['medium']/len(self.validation_results)*100:.1f}%)")
        print(f"• Low confidence queries: {confidence_counts['low']} ({confidence_counts['low']/len(self.validation_results)*100:.1f}%)")
        print(f"• Queries with poor keyword coverage (<30%): {poor_coverage} ({poor_coverage/len(self.validation_results)*100:.1f}%)")
        print(f"• Queries with many unverified claims (>3): {high_unverified} ({high_unverified/len(self.validation_results)*100:.1f}%)")
        print()
    
    def _generate_quality_distribution(self):
        """Generate quality score distribution"""
        print("QUALITY SCORE DISTRIBUTION:")
        print("-" * 40)
        
        score_ranges = {
            'Excellent (0.9-1.0)': 0,
            'Very Good (0.8-0.9)': 0,
            'Good (0.7-0.8)': 0,
            'Fair (0.5-0.7)': 0,
            'Poor (0.3-0.5)': 0,
            'Very Poor (0.0-0.3)': 0
        }
        
        for result in self.validation_results:
            score = result['quality_analysis']['overall_score']
            if score >= 0.9:
                score_ranges['Excellent (0.9-1.0)'] += 1
            elif score >= 0.8:
                score_ranges['Very Good (0.8-0.9)'] += 1
            elif score >= 0.7:
                score_ranges['Good (0.7-0.8)'] += 1
            elif score >= 0.5:
                score_ranges['Fair (0.5-0.7)'] += 1
            elif score >= 0.3:
                score_ranges['Poor (0.3-0.5)'] += 1
            else:
                score_ranges['Very Poor (0.0-0.3)'] += 1
        
        for range_name, count in score_ranges.items():
            percentage = (count / len(self.validation_results)) * 100
            print(f"• {range_name}: {count} queries ({percentage:.1f}%)")
        print()
    
    def _generate_content_analysis(self):
        """Generate content analysis"""
        print("CONTENT ANALYSIS:")
        print("-" * 40)
        
        # Analyze most common missing terms
        all_missing_terms = []
        all_found_terms = []
        
        for result in self.validation_results:
            all_missing_terms.extend(result['quality_analysis']['keyword_coverage']['missing_terms'])
            all_found_terms.extend(result['quality_analysis']['keyword_coverage']['found_terms_list'])
        
        missing_term_counts = Counter(all_missing_terms)
        found_term_counts = Counter(all_found_terms)
        
        print("Most Common Missing Terms (may indicate gaps in thread data):")
        for term, count in missing_term_counts.most_common(10):
            print(f"  • '{term}': missing in {count} queries")
        
        print(f"\nMost Common Found Terms:")
        for term, count in found_term_counts.most_common(10):
            print(f"  • '{term}': found in {count} queries")
        
        # Analyze unverified claims
        all_unverified = []
        for result in self.validation_results:
            all_unverified.extend(result['quality_analysis']['claims_analysis']['unverified_claims'])
        
        unverified_counts = Counter(all_unverified)
        
        if unverified_counts:
            print(f"\nMost Common Unverified Claims:")
            for claim, count in unverified_counts.most_common(10):
                print(f"  • {claim}: appears {count} times")
        
        print()
    
    def _generate_problematic_queries(self):
        """Generate analysis of problematic queries"""
        print("PROBLEMATIC QUERIES ANALYSIS:")
        print("-" * 40)
        
        # Sort by quality score (lowest first)
        problematic_queries = sorted(self.validation_results, key=lambda x: x['quality_analysis']['overall_score'])[:15]
        
        print("Top 15 Lowest Quality Queries:")
        for i, result in enumerate(problematic_queries, 1):
            quality = result['quality_analysis']
            coverage = quality['keyword_coverage']
            
            print(f"\n{i}. Query Index: {result['query_index']} | User: {result['user_id']}")
            print(f"   Quality Score: {quality['overall_score']:.3f} | Coverage: {coverage['coverage_score']:.3f}")
            print(f"   Question: {result['question'][:150]}..." if len(result['question']) > 150 else f"   Question: {result['question']}")
            
            if coverage['missing_terms']:
                print(f"   Missing key terms: {', '.join(coverage['missing_terms'][:8])}")
            
            if quality['claims_analysis']['unverified_claims']:
                print(f"   Unverified claims: {len(quality['claims_analysis']['unverified_claims'])}")
                for claim in quality['claims_analysis']['unverified_claims'][:3]:
                    print(f"     • {claim}")
        
        print()
    
    def _generate_recommendations(self):
        """Generate recommendations for improvement"""
        print("RECOMMENDATIONS FOR IMPROVEMENT:")
        print("-" * 40)
        
        # Calculate statistics for recommendations
        low_quality_count = sum(1 for r in self.validation_results if r['quality_analysis']['overall_score'] < 0.5)
        poor_coverage_count = sum(1 for r in self.validation_results 
                                if r['quality_analysis']['keyword_coverage']['coverage_score'] < 0.3)
        high_unverified_count = sum(1 for r in self.validation_results 
                                  if len(r['quality_analysis']['claims_analysis']['unverified_claims']) > 3)
        
        recommendations = []
        
        if low_quality_count > len(self.validation_results) * 0.2:  # More than 20%
            recommendations.append(
                f"🚨 HIGH PRIORITY: {low_quality_count} queries ({low_quality_count/len(self.validation_results)*100:.1f}%) "
                "have low quality scores. Review the query generation process to improve grounding in source data."
            )
        
        if poor_coverage_count > len(self.validation_results) * 0.15:  # More than 15%  
            recommendations.append(
                f"📚 HIGH PRIORITY: {poor_coverage_count} queries ({poor_coverage_count/len(self.validation_results)*100:.1f}%) "
                "have poor keyword coverage. Expand thread data or improve question-answer alignment."
            )
        
        if high_unverified_count > len(self.validation_results) * 0.1:  # More than 10%
            recommendations.append(
                f"🔍 MEDIUM PRIORITY: {high_unverified_count} queries contain many unverified claims. "
                "Implement better fact-checking against source documents."
            )
        
        # General recommendations
        recommendations.extend([
            "📊 Implement keyword-based validation in the query generation pipeline",
            "🎯 Create a curated list of domain-specific terms for better coverage analysis", 
            "🔄 Regular audits using semantic similarity metrics beyond keyword matching",
            "📋 Establish quality thresholds and reject queries below minimum standards",
            "🛠️ Develop automated tools to identify and flag potential hallucinations"
        ])
        
        for i, rec in enumerate(recommendations, 1):
            print(f"{i}. {rec}")
        
        print()
    
    def save_detailed_results(self, output_file: str = "keyword_validation_results.json"):
        """Save detailed validation results to a JSON file"""
        # Prepare simplified results for JSON serialization
        simplified_results = []
        for result in self.validation_results:
            simplified_result = {
                'query_index': result['query_index'],
                'user_id': result['user_id'],
                'question': result['question'],
                'answer_length': result['answer_length'],
                'overall_score': result['quality_analysis']['overall_score'],
                'keyword_coverage_score': result['quality_analysis']['keyword_coverage']['coverage_score'],
                'confidence_level': result['quality_analysis']['confidence_level'],
                'found_terms_count': result['quality_analysis']['keyword_coverage']['found_terms'],
                'total_terms_count': result['quality_analysis']['keyword_coverage']['total_terms'],
                'missing_terms': result['quality_analysis']['keyword_coverage']['missing_terms'],
                'unverified_claims': result['quality_analysis']['claims_analysis']['unverified_claims'],
                'verified_claims': result['quality_analysis']['claims_analysis']['verified_claims']
            }
            simplified_results.append(simplified_result)
        
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(simplified_results, f, indent=2, ensure_ascii=False)
        print(f"Detailed results saved to {output_file}")

def main():
    # Initialize the analyzer
    analyzer = KeywordBasedValidationAnalyzer(
        queries_file="/Users/telkar.varasree/Downloads/xyne/server/queries.json",
        thread_data_file="/Users/telkar.varasree/Downloads/xyne/server/threadId_data.json"
    )
    
    # Load data and build indices
    analyzer.load_data()
    
    # Validate all queries
    analyzer.validate_all_queries()
    
    # Generate comprehensive report
    analyzer.generate_comprehensive_report()
    
    # Save detailed results
    analyzer.save_detailed_results("/Users/telkar.varasree/Downloads/xyne/keyword_validation_results.json")

if __name__ == "__main__":
    main()