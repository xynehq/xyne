import * as fs from 'fs';
import * as path from 'path';

const replaceDimensions = (
  filePath: string, 
  modelDimension: number
): void => {
  try {
    const schemaContent = fs.readFileSync(filePath, 'utf8');
    const replacedContent = schemaContent.replace(/v\[(?:DIMS|\d+)\]/g, `v[${modelDimension.toString()}]`);

    // Write the modified content to the output file
    fs.writeFileSync(filePath, replacedContent, 'utf8');
  } catch (error) {
    console.error('Error processing Vespa schema file:', error);
    process.exit(1);
  }
};

const replaceModelDIMS = (filePaths: Array<string>,modelDimension: number): void => {
  filePaths.forEach(p => {
    try {
      replaceDimensions(
        p, 
        modelDimension
      );
    } catch (error) {
      console.error(`Failed to process ${p}:`, error);
    }
  });
};

const args = process.argv.slice(2)
const getDotSdpaths = (directory: string) => {
    return fs.readdirSync(directory)
        .filter(file => path.extname(file) === ".sd")
        .map(file => path.join(directory, file));
};

const paths = getDotSdpaths("./schemas");

replaceModelDIMS(paths, parseInt(args[0]));
