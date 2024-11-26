import pytrec_eval
import sys
import argparse

def main():
    # Argument parser to get file paths from the command line
    parser = argparse.ArgumentParser(description='Evaluate TREC QREL results.')
    parser.add_argument(
        '--qrel_file', 
        required=True, 
        help='Path to the qrel file (--qrels_file path/to/qrels/.tsv)'
    )
    parser.add_argument(
        '--run_file', 
        required=True,
        help='Path to the run file (--qrels_file path/to/run_file/.tsv)'
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
        # this line will print all the results
        # print_line(measure, 'all', avg_value)

        if measure == "P_10":
            precision_at_10 = avg_value
        if measure == "recall_10":
            recall_at_10 = avg_value
        if measure == "recall_5":
            print("Recall@5:", f"{avg_value:.4f}")
        if measure == "ndcg_cut_10":
            print("NDCG@10:", f"{avg_value:.4f}")
        if measure == "ndcg_cut_5":
            print("NDCG@5:", f"{avg_value:.4f}")
        if measure == "map_cut_10":
            print("Map@10:", f"{avg_value:.4f}")
        if measure == "recip_rank":
            print("MRR@10:", f"{avg_value:.4f}")
    if precision_at_10 is not None and recall_at_10 is not None:
        f1_score = 2 * (precision_at_10 * recall_at_10) / (precision_at_10 + recall_at_10) if (precision_at_10 + recall_at_10) != 0 else 0
        print(f"Precision@10: {precision_at_10:.4f}")
        print(f"Recall@10: {recall_at_10:.4f}")
        print(f"F1-Score: {f1_score}")


if __name__ == "__main__":
    sys.exit(main())
