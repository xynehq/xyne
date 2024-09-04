// npm i @xenova/transformers
import { pipeline, dot } from '@xenova/transformers';
function progress_callback(args) {
    if (args.status != 'progress') return;
    let n = Math.floor(args.progress / 5);
    let str = '\r[' + '#'.repeat(n) + '.'.repeat(20 - n) + '] ' + args.file + (n == 20 ? '\n' : '');
    process.stdout.write(str);
}

// Create feature extraction pipeline
const extractor = await pipeline('feature-extraction', 'Alibaba-NLP/gte-large-en-v1.5', {
    quantized: false, // Comment out this line to use the quantized version
    progress_callback
});


// Generate sentence embeddings
const sentences = [
    "what is the capital of China?",
    "how to implement quick sort in python?",
    "Beijing",
    "sorting algorithms"
]
const output = await extractor(sentences, { normalize: true, pooling: 'cls' });

// Compute similarity scores
const [source_embeddings, ...document_embeddings] = output.tolist();
const similarities = document_embeddings.map(x => 100 * dot(source_embeddings, x));
console.log(similarities); // [41.86354093370361, 77.07076371259589, 37.02981979677899]

