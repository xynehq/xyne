export function getDateForAI() {
    const today = new Date();
    const options = {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    };
    return today.toLocaleDateString("en-GB", options);
}
export const calculateCost = ({ inputTokens, outputTokens }, cost) => {
    const inputCost = (inputTokens / 1000) * cost.pricePerThousandInputTokens;
    const outputCost = (outputTokens / 1000) * cost.pricePerThousandOutputTokens;
    return inputCost + outputCost;
};
