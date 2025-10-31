import json
import pandas as pd
import os

def analyze_data(file_path, output_dir):
    """
    Reads and analyzes the tool scorer JSON data to generate two summary tables.

    Args:
        file_path (str): The path to the JSON file.
    """
    try:
        with open(file_path, 'r') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"Error: The file at {file_path} was not found.")
        return
    except json.JSONDecodeError:
        print(f"Error: The file at {file_path} is not a valid JSON file.")
        return

    # --- Table 1: Question-wise Performance Analysis ---
    question_data = []
    for result in data.get('results', []):
        scores = result.get('Scores', {})
        question_data.append({
            'Q_id': result.get('question_id'),
            'Question': result.get('Question'),
            'Answer': result.get('Answer'),
            'Agentic_answer': result.get('Agentic_answer'),
            'Total tools called': len(result.get('Tool_results', [])),
            'Average precision': scores.get('average_precision'),
            'Total recall': scores.get('total_recall'),
            'Factuality score': scores.get('Factuality'),
            'Completeness score': scores.get('Completeness'),
            'Overall score': scores.get('Overall_Score')
        })

    df_questions = pd.DataFrame(question_data)
    df_questions.index.name = 'S.No'
    df_questions.index += 1


    # --- Table 2: Tool Performance Analysis ---
    tool_names = [
        "searchGlobal",
        "getSlackMessages",
        "getUserSlackProfile",
        "searchGmail",
        "searchDriveFiles",
        "searchCalendarEvents",
        "searchGoogleContacts"
    ]
    tool_performance = {tool: {'total_calls': 0, 'total_intersection': 0, 'total_recall': 0.0, 'questions': set()} for tool in tool_names}

    for result in data.get('results', []):
        question_id = result.get('question_id')
        for tool_call in result.get('Tool_results', []):
            tool_name = tool_call.get('ToolName')
            if tool_name in tool_performance:
                tool_performance[tool_name]['total_calls'] += 1
                tool_performance[tool_name]['total_intersection'] += tool_call.get('intersection_count', 0)
                tool_performance[tool_name]['total_recall'] += tool_call.get('recall', 0.0)
                tool_performance[tool_name]['questions'].add(question_id)

    for tool in tool_performance:
        num_questions_with_tool = len(tool_performance[tool]['questions'])
        if num_questions_with_tool > 0:
            tool_performance[tool]['average_recall'] = tool_performance[tool]['total_recall'] / num_questions_with_tool
        else:
            tool_performance[tool]['average_recall'] = 0.0

    tool_data_list = []
    for name, stats in tool_performance.items():
        tool_data_list.append({
            'Tool Name': name,
            'Total Times Called': stats['total_calls'],
            'Total Intersection Docs': stats['total_intersection'],
            'Average Recall': stats['average_recall']
        })

    df_tools = pd.DataFrame(tool_data_list)
    df_tools.index.name = 'S.No'
    df_tools.index += 1

    # --- Print Tables ---
    print("--- Question-wise Performance Analysis ---")
    print(df_questions.to_string())
    print("\n" + "="*100 + "\n")
    print("--- Tool Performance Analysis ---")
    print(df_tools.to_string())

    # --- Save to Excel ---
    os.makedirs(output_dir, exist_ok=True)
    question_excel_path = os.path.join(output_dir, 'question_performance.xlsx')
    tool_excel_path = os.path.join(output_dir, 'tool_performance.xlsx')
    
    df_questions.to_excel(question_excel_path, sheet_name='Question Performance')
    df_tools.to_excel(tool_excel_path, sheet_name='Tool Performance')
    
    print(f"\nTables saved to {question_excel_path} and {tool_excel_path}")


if __name__ == '__main__':
    # Path to the JSON file
    json_file_path = 'server/xyne-evals/reports/results_of_actual_data/tool_scorers.json'
    output_directory = 'server/xyne-evals/reports/results_of_actual_data'
    analyze_data(json_file_path, output_directory)
