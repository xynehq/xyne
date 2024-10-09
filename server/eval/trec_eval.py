import pytrec_eval
import sys
import argparse

def main():
    # Argument parser to get file paths from the command line
    parser = argparse.ArgumentParser(description='Evaluate TREC QREL results.')
    parser.add_argument(
        '--qrel_file', 
        default='data/output/dev_trec_qrels.tsv', 
        help='Path to the qrel file (default: data/output/dev_trec_qrels.tsv)'
    )
    parser.add_argument(
        '--run_file', 
        default='data/output/fiqa_result_qrels.tsv', 
        help='Path to the run file (default: data/output/fiqa_result_qrels.tsv)'
    )
    
    args = parser.parse_args()

    # Open the provided file paths or use default
    with open(args.qrel_file, 'r') as f_qrel:
        qrel = pytrec_eval.parse_qrel(f_qrel)

    with open(args.run_file, 'r') as f_run:
        run = pytrec_eval.parse_run(f_run)

    # Specify the measures you want to evaluate
    evaluator = pytrec_eval.RelevanceEvaluator(
        qrel, pytrec_eval.supported_measures
    )

    results = evaluator.evaluate(run)

    def print_line(measure, scope, value):
        print('{:25s}{:8s}{:.4f}'.format(measure, scope, value))

    # this is print per_query results
    # for query_id, query_measures in sorted(results.items()):
    #         for measure, value in sorted(query_measures.items()):
    #             print_line(measure, query_id, value)

    # Compute and print the overall (average) result for each metric
    print("Overall Results (Averages):")
    
    # Get measures from the first query (since all queries should have the same measures)
    first_query_measures = next(iter(results.values())).keys()

    # Loop through each measure and compute its overall average
    for measure in sorted(first_query_measures):
        avg_value = pytrec_eval.compute_aggregated_measure(
            measure,
            [query_measures[measure] for query_measures in results.values()]
        )
        print_line(measure, 'all', avg_value)

if __name__ == "__main__":
    sys.exit(main())
