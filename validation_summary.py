#!/usr/bin/env python3

import json
from collections import defaultdict, Counter
from datetime import datetime

def analyze_validation_results():
    """Analyze the validation results and provide specific insights"""
    
    # Load the validation results
    with open("/Users/telkar.varasree/Downloads/xyne/keyword_validation_results.json", 'r') as f:
        results = json.load(f)
    
    print("="*80)
    print("QUERY VALIDATION SUMMARY REPORT")
    print("="*80)
    print(f"Analysis Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Total Queries Analyzed: {len(results)}")
    print()
    
    # 1. Check if questions are properly grounded in data
    print("1. QUESTION GROUNDING ANALYSIS:")
    print("-" * 50)
    
    well_grounded = sum(1 for r in results if r['keyword_coverage_score'] >= 0.7)
    moderately_grounded = sum(1 for r in results if 0.4 <= r['keyword_coverage_score'] < 0.7)
    poorly_grounded = sum(1 for r in results if r['keyword_coverage_score'] < 0.4)
    
    print(f"• Well grounded questions (≥70% keyword coverage): {well_grounded} ({well_grounded/len(results)*100:.1f}%)")
    print(f"• Moderately grounded questions (40-70% coverage): {moderately_grounded} ({moderately_grounded/len(results)*100:.1f}%)")
    print(f"• Poorly grounded questions (<40% coverage): {poorly_grounded} ({poorly_grounded/len(results)*100:.1f}%)")
    
    if poorly_grounded > 0:
        print(f"\n   ⚠️  {poorly_grounded} questions may be asking about topics not well covered in the thread data")
    
    # 2. Check for questions asking more than what's in the data
    print(f"\n2. SCOPE VALIDATION ANALYSIS:")
    print("-" * 50)
    
    # Questions with many missing terms might be asking beyond available data
    out_of_scope = [r for r in results if len(r['missing_terms']) > 5 and r['keyword_coverage_score'] < 0.5]
    
    print(f"• Questions potentially asking beyond available data: {len(out_of_scope)} ({len(out_of_scope)/len(results)*100:.1f}%)")
    
    if out_of_scope:
        print("   Sample out-of-scope questions:")
        for i, q in enumerate(out_of_scope[:3], 1):
            print(f"   {i}. Query {q['query_index']}: {q['question'][:100]}...")
            print(f"      Missing terms: {', '.join(q['missing_terms'][:5])}")
    
    # 3. Check for hallucinated answers
    print(f"\n3. HALLUCINATION DETECTION:")
    print("-" * 50)
    
    high_hallucination_risk = sum(1 for r in results if len(r['unverified_claims']) > 3)
    medium_hallucination_risk = sum(1 for r in results if 1 <= len(r['unverified_claims']) <= 3)
    low_hallucination_risk = sum(1 for r in results if len(r['unverified_claims']) == 0)
    
    print(f"• Low hallucination risk (no unverified claims): {low_hallucination_risk} ({low_hallucination_risk/len(results)*100:.1f}%)")
    print(f"• Medium hallucination risk (1-3 unverified claims): {medium_hallucination_risk} ({medium_hallucination_risk/len(results)*100:.1f}%)")
    print(f"• High hallucination risk (>3 unverified claims): {high_hallucination_risk} ({high_hallucination_risk/len(results)*100:.1f}%)")
    
    # Analyze most common unverified claims
    all_unverified = []
    for r in results:
        all_unverified.extend(r['unverified_claims'])
    
    unverified_counts = Counter(all_unverified)
    
    if unverified_counts:
        print(f"\n   Most frequently unverified claims:")
        for claim, count in unverified_counts.most_common(10):
            print(f"   • {claim}: appears {count} times")
    
    # 4. Answer accuracy validation
    print(f"\n4. ANSWER ACCURACY ASSESSMENT:")
    print("-" * 50)
    
    high_accuracy = sum(1 for r in results if r['overall_score'] >= 0.8)
    medium_accuracy = sum(1 for r in results if 0.6 <= r['overall_score'] < 0.8)
    low_accuracy = sum(1 for r in results if r['overall_score'] < 0.6)
    
    print(f"• High accuracy answers (≥80% score): {high_accuracy} ({high_accuracy/len(results)*100:.1f}%)")
    print(f"• Medium accuracy answers (60-80% score): {medium_accuracy} ({medium_accuracy/len(results)*100:.1f}%)")
    print(f"• Low accuracy answers (<60% score): {low_accuracy} ({low_accuracy/len(results)*100:.1f}%)")
    
    # 5. Identify most problematic queries
    print(f"\n5. MOST PROBLEMATIC QUERIES:")
    print("-" * 50)
    
    # Sort by overall score (lowest first)
    problematic = sorted(results, key=lambda x: x['overall_score'])[:10]
    
    for i, query in enumerate(problematic, 1):
        print(f"\n{i}. Query {query['query_index']} | User: {query['user_id']}")
        print(f"   Overall Score: {query['overall_score']:.3f}")
        print(f"   Coverage Score: {query['keyword_coverage_score']:.3f}")
        print(f"   Question: {query['question'][:120]}..." if len(query['question']) > 120 else f"   Question: {query['question']}")
        
        if query['missing_terms']:
            print(f"   Key missing terms: {', '.join(query['missing_terms'][:5])}")
        
        if query['unverified_claims']:
            print(f"   Unverified claims ({len(query['unverified_claims'])}): {', '.join(query['unverified_claims'][:3])}")
    
    # 6. Data coverage analysis
    print(f"\n6. THREAD DATA COVERAGE ANALYSIS:")
    print("-" * 50)
    
    # Analyze missing terms to understand data gaps
    all_missing_terms = []
    for r in results:
        all_missing_terms.extend(r['missing_terms'])
    
    missing_term_counts = Counter(all_missing_terms)
    
    print("Terms frequently missing from thread data (potential data gaps):")
    for term, count in missing_term_counts.most_common(15):
        if count > 5:  # Only show terms missing in multiple queries
            print(f"   • '{term}': missing in {count} queries ({count/len(results)*100:.1f}%)")
    
    # 7. Overall conclusions
    print(f"\n7. OVERALL CONCLUSIONS:")
    print("-" * 50)
    
    avg_score = sum(r['overall_score'] for r in results) / len(results)
    avg_coverage = sum(r['keyword_coverage_score'] for r in results) / len(results)
    
    print(f"• Average overall quality score: {avg_score:.3f}/1.0")
    print(f"• Average keyword coverage: {avg_coverage:.3f}/1.0")
    print()
    
    if avg_score >= 0.8:
        print("✅ CONCLUSION: Overall query quality is HIGH")
    elif avg_score >= 0.6:
        print("⚠️  CONCLUSION: Overall query quality is MEDIUM")
    else:
        print("❌ CONCLUSION: Overall query quality is LOW")
    
    print()
    
    # Issues summary
    total_issues = poorly_grounded + len(out_of_scope) + high_hallucination_risk + low_accuracy
    
    if total_issues == 0:
        print("🎉 No significant issues detected in the query-answer validation")
    elif total_issues < len(results) * 0.1:  # Less than 10%
        print(f"✅ Minor issues detected ({total_issues} queries, {total_issues/len(results)*100:.1f}%)")
    elif total_issues < len(results) * 0.2:  # Less than 20%
        print(f"⚠️  Moderate issues detected ({total_issues} queries, {total_issues/len(results)*100:.1f}%)")
    else:
        print(f"❌ Significant issues detected ({total_issues} queries, {total_issues/len(results)*100:.1f}%)")
    
    # Specific recommendations
    print(f"\n8. SPECIFIC RECOMMENDATIONS:")
    print("-" * 50)
    
    if poorly_grounded > len(results) * 0.1:
        print("• Review and expand thread data to better cover the topics being queried")
    
    if len(out_of_scope) > len(results) * 0.05:
        print("• Implement question filtering to reject queries that exceed available data scope")
    
    if high_hallucination_risk > len(results) * 0.05:
        print("• Strengthen fact-checking mechanisms to reduce unverified claims in answers")
    
    if low_accuracy > len(results) * 0.1:
        print("• Improve answer generation pipeline to ensure better grounding in source data")
    
    print("• Regular validation audits using keyword-based analysis")
    print("• Implement confidence scoring for generated answers")
    print("• Create domain-specific validation rules for technical terms and references")

if __name__ == "__main__":
    analyze_validation_results()