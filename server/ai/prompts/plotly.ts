export const generatePlotlyCodePrompt = (
  data: any,
  title?: string,
  description?: string,
) => `
You are an expert in data visualization and Plotly.js. Your task is to analyze the provided dataset and generate up to three of the most suitable Plotly chart configurations.

**Data:**
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

**Chart Parameters:**
- Title: ${title || "Data Visualization"}
- Description: ${description || ""}

**Instructions:**

1.  **Analyze the Data:** Carefully examine the structure of the provided data. Identify the data types (categorical, numerical, time-series), the number of variables, and the relationships between them.
2.  **Rank Chart Types:** Based on your analysis, rank the most suitable chart types for visualizing this data. Consider the user's description if provided. For example:
    *   Use bar charts for comparing categorical data.
    *   Use line charts for time-series data.
    *   Use scatter plots for exploring relationships between two numerical variables.
    *   Use pie charts for showing parts of a whole.
3.  **Generate Configurations:** For the top-ranked chart types (up to a maximum of three), generate a complete and valid Plotly JSON configuration.
    *   If the user's request is very specific and only one chart type is appropriate, it is acceptable to return only one configuration.
4.  **Handle Complex Data:** For multi-dimensional data (e.g., an array of numbers for a single metric), use Plotly's \`transforms\` feature to perform aggregations (e.g., sum, average). Do not perform any calculations yourself; let Plotly handle the data aggregation.
5.  **Return JSON:** Your final output must be a single, valid JSON object containing the number of charts, a list of chart types, and an array of the generated Plotly configurations. Do not include any other text or explanations.

**Example Output:**
\`\`\`json
{
  "count": 2,
  "types": ["bar", "pie"],
  "charts": [
    {
      "data": [
        {
          "type": "bar",
          "x": ["Category A", "Category B", "Category C"],
          "y": [10, 20, 15]
        }
      ],
      "layout": {
        "title": {
          "text": "Bar Chart"
        }
      },
      "config": {
        "responsive": true
      }
    },
    {
      "data": [
        {
          "type": "pie",
          "labels": ["Category A", "Category B", "Category C"],
          "values": [10, 20, 15]
        }
      ],
      "layout": {
        "title": {
          "text": "Pie Chart"
        }
      },
      "config": {
        "responsive": true
      }
    }
  ]
}
\`\`\`
`
