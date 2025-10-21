#!/usr/bin/env python3

import json
import sys
from collections import defaultdict

def analyze_score_distribution(file_path):
    """
    Analyze the distribution of generated scores in score ranges.
    Returns a dictionary with score ranges as keys and counts as values.
    """
    try:
        with open(file_path, 'r') as f:
            data = json.load(f)
        
        # Initialize score range counters
        score_ranges = {
            '0-10': 0,
            '10-20': 0,
            '20-30': 0,
            '30-40': 0,
            '40-50': 0,
            '50-60': 0,
            '60-70': 0,
            '70-80': 0,
            '80-90': 0,
            '90-100': 0
        }
        
        # Extract results array
        results = data.get('results', [])
        total_queries = len(results)
        
        print(f"\nAnalyzing {file_path}:")
        print(f"Total queries: {total_queries}")
        
        # Process each result
        for result in results:
            # Get the generated score
            generated_score = result.get('overallScoreGenerated')
            
            # Handle different possible score formats
            if generated_score is None:
                generated_score = result.get('score')
            
            if generated_score is not None:
                # Convert to integer if it's a string
                if isinstance(generated_score, str):
                    try:
                        generated_score = int(generated_score)
                    except ValueError:
                        print(f"Warning: Could not parse score '{generated_score}' in {file_path}")
                        continue
                
                # Categorize into score ranges
                if 0 <= generated_score < 10:
                    score_ranges['0-10'] += 1
                elif 10 <= generated_score < 20:
                    score_ranges['10-20'] += 1
                elif 20 <= generated_score < 30:
                    score_ranges['20-30'] += 1
                elif 30 <= generated_score < 40:
                    score_ranges['30-40'] += 1
                elif 40 <= generated_score < 50:
                    score_ranges['40-50'] += 1
                elif 50 <= generated_score < 60:
                    score_ranges['50-60'] += 1
                elif 60 <= generated_score < 70:
                    score_ranges['60-70'] += 1
                elif 70 <= generated_score < 80:
                    score_ranges['70-80'] += 1
                elif 80 <= generated_score < 90:
                    score_ranges['80-90'] += 1
                elif 90 <= generated_score <= 100:
                    score_ranges['90-100'] += 1
                else:
                    print(f"Warning: Score {generated_score} is outside expected range (0-100)")
        
        return score_ranges, total_queries
        
    except FileNotFoundError:
        print(f"Error: File {file_path} not found")
        return None, 0
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in {file_path}: {e}")
        return None, 0
    except Exception as e:
        print(f"Error processing {file_path}: {e}")
        return None, 0

def print_score_distribution(score_ranges, total_queries, file_name):
    """Print the score distribution in a formatted table."""
    print(f"\n{'='*50}")
    print(f"SCORE DISTRIBUTION FOR {file_name.upper()}")
    print(f"{'='*50}")
    print(f"{'Score Range':<12} {'Count':<8} {'Percentage':<12}")
    print(f"{'-'*32}")
    
    for range_key, count in score_ranges.items():
        percentage = (count / total_queries * 100) if total_queries > 0 else 0
        print(f"{range_key:<12} {count:<8} {percentage:<8.1f}%")
    
    print(f"{'-'*32}")
    print(f"{'Total':<12} {total_queries:<8} {'100.0%':<12}")

def compare_distributions(cp50_ranges, cp50_total, cp231_ranges, cp231_total):
    """Compare the two distributions side by side."""
    print(f"\n{'='*70}")
    print(f"COMPARISON: CP-50 vs CP-231")
    print(f"{'='*70}")
    print(f"{'Score Range':<12} {'CP-50':<10} {'CP-50 %':<10} {'CP-231':<10} {'CP-231 %':<10}")
    print(f"{'-'*70}")
    
    for range_key in cp50_ranges.keys():
        cp50_count = cp50_ranges[range_key]
        cp231_count = cp231_ranges[range_key]
        cp50_pct = (cp50_count / cp50_total * 100) if cp50_total > 0 else 0
        cp231_pct = (cp231_count / cp231_total * 100) if cp231_total > 0 else 0
        
        print(f"{range_key:<12} {cp50_count:<10} {cp50_pct:<8.1f}% {cp231_count:<10} {cp231_pct:<8.1f}%")
    
    print(f"{'-'*70}")
    print(f"{'Total':<12} {cp50_total:<10} {'100.0%':<8} {cp231_total:<10} {'100.0%':<8}")

def main():
    # File paths
    cp50_file = "/Users/telkar.varasree/Downloads/cp_50_new.json"
    cp231_file = "/Users/telkar.varasree/Downloads/cp_231 (1).json"
    
    print("Score Distribution Analysis")
    print("="*50)
    
    # Analyze CP-50 file
    cp50_ranges, cp50_total = analyze_score_distribution(cp50_file)
    
    # Analyze CP-231 file
    cp231_ranges, cp231_total = analyze_score_distribution(cp231_file)
    
    if cp50_ranges and cp231_ranges:
        # Print individual distributions
        print_score_distribution(cp50_ranges, cp50_total, "CP-50")
        print_score_distribution(cp231_ranges, cp231_total, "CP-231")
        
        # Print comparison
        compare_distributions(cp50_ranges, cp50_total, cp231_ranges, cp231_total)
        
        # Summary statistics
        print(f"\n{'='*50}")
        print(f"SUMMARY STATISTICS")
        print(f"{'='*50}")
        
        # Calculate average scores
        def calculate_average_score(ranges, total):
            if total == 0:
                return 0
            weighted_sum = 0
            for range_key, count in ranges.items():
                # Use midpoint of range for calculation
                if range_key == '90-100':
                    midpoint = 95  # Special case for 90-100 range
                else:
                    start = int(range_key.split('-')[0])
                    end = int(range_key.split('-')[1])
                    midpoint = (start + end) / 2
                weighted_sum += midpoint * count
            return weighted_sum / total
        
        cp50_avg = calculate_average_score(cp50_ranges, cp50_total)
        cp231_avg = calculate_average_score(cp231_ranges, cp231_total)
        
        print(f"CP-50 Average Score (estimated): {cp50_avg:.1f}")
        print(f"CP-231 Average Score (estimated): {cp231_avg:.1f}")
        
        # Count scores above/below thresholds
        def count_above_threshold(ranges, threshold):
            count = 0
            for range_key, range_count in ranges.items():
                start = int(range_key.split('-')[0])
                if start >= threshold:
                    count += range_count
            return count
        
        cp50_above_60 = count_above_threshold(cp50_ranges, 60)
        cp231_above_60 = count_above_threshold(cp231_ranges, 60)
        cp50_above_80 = count_above_threshold(cp50_ranges, 80)
        cp231_above_80 = count_above_threshold(cp231_ranges, 80)
        
        print(f"\nScores >= 60:")
        print(f"  CP-50: {cp50_above_60}/{cp50_total} ({cp50_above_60/cp50_total*100:.1f}%)")
        print(f"  CP-231: {cp231_above_60}/{cp231_total} ({cp231_above_60/cp231_total*100:.1f}%)")
        
        print(f"\nScores >= 80:")
        print(f"  CP-50: {cp50_above_80}/{cp50_total} ({cp50_above_80/cp50_total*100:.1f}%)")
        print(f"  CP-231: {cp231_above_80}/{cp231_total} ({cp231_above_80/cp231_total*100:.1f}%)")
        
    else:
        print("Error: Could not analyze one or both files")
        sys.exit(1)

if __name__ == "__main__":
    main()