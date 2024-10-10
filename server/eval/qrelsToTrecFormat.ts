import fs from "node:fs";
import path from "node:path";
const readline = require('readline');



const modify = async () => {
    const processedResultsData: any[] = []
    
    try {
        const fileStream = fs.createReadStream(path.resolve(__dirname, "data/fiqa/qrels/dev.tsv"));
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });
        for await (const line of rl) {
            const columns = line.split('\t');
            // TREC format for qrels query_id 0 document_id relevance_score
            processedResultsData.push(`${columns[0]}\t0\t${columns[1]}\t${columns[2]}`)
        }

        fs.promises.writeFile('data/fiqa/dev_trec_qrels.tsv', processedResultsData.join("\n"))
        console.log("qrels processed successfull");
    } catch (error) {
        console.error("Error processing :" + error)
    }
}

await modify()