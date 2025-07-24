// Simple test data
const testData = {
  "gpt-4o": 4.5,
  "gpt-4o-mini": 4.2,
  claude: 4.1,
}

console.log("Test data:", JSON.stringify(testData, null, 2))

// Expected Plotly config structure
const expectedConfig = {
  data: [
    {
      x: Object.keys(testData),
      y: Object.values(testData),
      type: "bar",
      name: "Model Scores",
      text: Object.values(testData).map((v) => v.toFixed(2)),
      textposition: "auto",
    },
  ],
  layout: {
    title: "Data Visualization",
    xaxis: { title: "" },
    yaxis: { title: "" },
  },
  config: {
    responsive: true,
    displayModeBar: true,
    modeBarButtonsToRemove: ["pan2d", "lasso2d"],
  },
}

console.log("Expected Plotly config:")
console.log(JSON.stringify(expectedConfig, null, 2))
