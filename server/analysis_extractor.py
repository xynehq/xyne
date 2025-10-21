#!/usr/bin/env python3
"""
Analysis Extractor for Comparison Results
Extracts numerical analysis from comparison_results.json and stores in a separate file.
"""

import json
import sys
from datetime import datetime
from pathlib import Path

def load_comparison_results(file_path):
    """Load and parse the comparison results JSON file."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data
    except FileNotFoundError:
        print(f"Error: File {file_path} not found.")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in {file_path}: {e}")
        sys.exit(1)

def extract_overall_scores(data):
    """Extract overall scores from the comparison results data."""
    try:
        # Extract from summary_statistics
        summary_stats = data.get('summary_statistics', {})
        average_scores = summary_stats.get('average_scores', {})
        final_overall_scores = summary_stats.get('final_overall_scores', {})
        
        # Primary source: final_overall_scores (if available)
        if final_overall_scores:
            overall_score_old = final_overall_scores.get('overall_score_old')
            overall_score_new = final_overall_scores.get('overall_score_new')
        else:
            # Fallback: calculate from average_scores
            overall_score_old = average_scores.get('oldOverall')
            overall_score_new = average_scores.get('newOverall')
        
        # Extract individual metric scores
        factuality_score_old = average_scores.get('oldFactuality')
        factuality_score_new = average_scores.get('newFactuality')
        completeness_score_old = average_scores.get('oldCompleteness')
        completeness_score_new = average_scores.get('newCompleteness')
        
        return {
            'overall_score_old': overall_score_old,
            'overall_score_new': overall_score_new,
            'factuality_score_old': factuality_score_old,
            'factuality_score_new': factuality_score_new,
            'completeness_score_old': completeness_score_old,
            'completeness_score_new': completeness_score_new
        }
    except Exception as e:
        print(f"Error extracting scores: {e}")
        sys.exit(1)

def calculate_improvements(scores):
    """Calculate improvement metrics."""
    improvements = {}
    
    # Overall improvement
    if scores['overall_score_old'] and scores['overall_score_new']:
        improvements['overall_improvement'] = scores['overall_score_new'] - scores['overall_score_old']
        improvements['overall_improvement_percentage'] = (
            improvements['overall_improvement'] / scores['overall_score_old'] * 100
        )
    
    # Factuality improvement
    if scores['factuality_score_old'] and scores['factuality_score_new']:
        improvements['factuality_improvement'] = scores['factuality_score_new'] - scores['factuality_score_old']
        improvements['factuality_improvement_percentage'] = (
            improvements['factuality_improvement'] / scores['factuality_score_old'] * 100
        )
    
    # Completeness improvement
    if scores['completeness_score_old'] and scores['completeness_score_new']:
        improvements['completeness_improvement'] = scores['completeness_score_new'] - scores['completeness_score_old']
        improvements['completeness_improvement_percentage'] = (
            improvements['completeness_improvement'] / scores['completeness_score_old'] * 100
        )
    
    return improvements

def extract_additional_metrics(data):
    """Extract additional metrics from the data."""
    try:
        metadata = data.get('metadata', {})
        summary_stats = data.get('summary_statistics', {})
        comparison_results = summary_stats.get('comparison_results', {})
        
        additional_metrics = {
            'total_queries': metadata.get('total_queries'),
            'generated_at': metadata.get('generated_at'),
            'model_used': metadata.get('model_used'),
            'old_wins': comparison_results.get('oldWins'),
            'new_wins': comparison_results.get('newWins'),
            'ties': comparison_results.get('ties'),
            'factuality_old_wins': comparison_results.get('factualityOldWins'),
            'factuality_new_wins': comparison_results.get('factualityNewWins'),
            'factuality_ties': comparison_results.get('factualityTies'),
            'completeness_old_wins': comparison_results.get('completenessOldWins'),
            'completeness_new_wins': comparison_results.get('completenessNewWins'),
            'completeness_ties': comparison_results.get('completenessTies')
        }
        
        return additional_metrics
    except Exception as e:
        print(f"Error extracting additional metrics: {e}")
        return {}

def save_analysis(scores, improvements, additional_metrics, output_file):
    """Save the extracted analysis to a file."""
    analysis_data = {
        'extraction_metadata': {
            'extracted_at': datetime.now().isoformat(),
            'script_version': '1.0',
            'source_file': 'comparison_results.json'
        },
        'core_scores': scores,
        'improvements': improvements,
        'additional_metrics': additional_metrics,
        'summary': {
            'description': 'Numerical analysis extracted from comparison_results.json',
            'key_findings': {
                'winner': 'old' if scores.get('overall_score_old', 0) > scores.get('overall_score_new', 0) else 'new',
                'overall_difference': improvements.get('overall_improvement', 0),
                'factuality_difference': improvements.get('factuality_improvement', 0),
                'completeness_difference': improvements.get('completeness_improvement', 0)
            }
        }
    }
    
    try:
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(analysis_data, f, indent=2, ensure_ascii=False)
        print(f"✅ Analysis saved to: {output_file}")
    except Exception as e:
        print(f"Error saving analysis: {e}")
        sys.exit(1)

def print_summary(scores, improvements, additional_metrics):
    """Print a summary of the extracted scores."""
    print("\n📊 EXTRACTED NUMERICAL ANALYSIS")
    print("=" * 50)
    
    print("\n🎯 CORE SCORES:")
    print(f"Overall Score (Old): {scores.get('overall_score_old', 'N/A'):.2f}" if scores.get('overall_score_old') else "Overall Score (Old): N/A")
    print(f"Overall Score (New): {scores.get('overall_score_new', 'N/A'):.2f}" if scores.get('overall_score_new') else "Overall Score (New): N/A")
    print(f"Factuality Score (Old): {scores.get('factuality_score_old', 'N/A'):.2f}" if scores.get('factuality_score_old') else "Factuality Score (Old): N/A")
    print(f"Factuality Score (New): {scores.get('factuality_score_new', 'N/A'):.2f}" if scores.get('factuality_score_new') else "Factuality Score (New): N/A")
    print(f"Completeness Score (Old): {scores.get('completeness_score_old', 'N/A'):.2f}" if scores.get('completeness_score_old') else "Completeness Score (Old): N/A")
    print(f"Completeness Score (New): {scores.get('completeness_score_new', 'N/A'):.2f}" if scores.get('completeness_score_new') else "Completeness Score (New): N/A")
    
    print("\n📈 IMPROVEMENTS:")
    if improvements.get('overall_improvement') is not None:
        sign = "+" if improvements['overall_improvement'] >= 0 else ""
        print(f"Overall Improvement: {sign}{improvements['overall_improvement']:.2f} ({sign}{improvements.get('overall_improvement_percentage', 0):.1f}%)")
    
    if improvements.get('factuality_improvement') is not None:
        sign = "+" if improvements['factuality_improvement'] >= 0 else ""
        print(f"Factuality Improvement: {sign}{improvements['factuality_improvement']:.2f} ({sign}{improvements.get('factuality_improvement_percentage', 0):.1f}%)")
    
    if improvements.get('completeness_improvement') is not None:
        sign = "+" if improvements['completeness_improvement'] >= 0 else ""
        print(f"Completeness Improvement: {sign}{improvements['completeness_improvement']:.2f} ({sign}{improvements.get('completeness_improvement_percentage', 0):.1f}%)")
    
    print("\n📋 COMPARISON RESULTS:")
    total_queries = additional_metrics.get('total_queries', 0)
    if total_queries > 0:
        old_wins = additional_metrics.get('old_wins', 0)
        new_wins = additional_metrics.get('new_wins', 0)
        ties = additional_metrics.get('ties', 0)
        
        print(f"Total Queries: {total_queries}")
        print(f"Old Wins: {old_wins} ({old_wins/total_queries*100:.1f}%)")
        print(f"New Wins: {new_wins} ({new_wins/total_queries*100:.1f}%)")
        print(f"Ties: {ties} ({ties/total_queries*100:.1f}%)")

def main():
    """Main function."""
    # Default file paths
    input_file = "/Users/telkar.varasree/Downloads/xyne/server/comparison_results.json"
    output_file = "/Users/telkar.varasree/Downloads/xyne/server/numerical_analysis.json"
    
    # Command line arguments handling
    if len(sys.argv) > 1:
        input_file = sys.argv[1]
    if len(sys.argv) > 2:
        output_file = sys.argv[2]
    
    print(f"🔍 Loading comparison results from: {input_file}")
    
    # Load and process data
    data = load_comparison_results(input_file)
    scores = extract_overall_scores(data)
    improvements = calculate_improvements(scores)
    additional_metrics = extract_additional_metrics(data)
    
    # Print summary to console
    print_summary(scores, improvements, additional_metrics)
    
    # Save to file
    save_analysis(scores, improvements, additional_metrics, output_file)
    
    print(f"\n🎉 Analysis extraction completed successfully!")
    print(f"📄 Results saved to: {output_file}")

if __name__ == "__main__":
    main()