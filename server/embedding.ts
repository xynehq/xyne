import { env, FeatureExtractionPipeline, pipeline } from "@xenova/transformers";
import { progress_callback } from "./utils";

env.backends.onnx.wasm.numThreads = 1;


env.localModelPath = './'
env.cacheDir = './'
export const getExtractor = async (): Promise<FeatureExtractionPipeline> => {
    return await pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5', { progress_callback, cache_dir: env.cacheDir });
}