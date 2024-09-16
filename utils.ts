import fs from "node:fs/promises";

export const checkAndReadFile = async (path: string) => {
    try {
        // Check if the file exists
        await fs.access(path);
        console.log(`File exists: ${path}`);

        // Read the file
        const data = JSON.parse(await fs.readFile(path, 'utf8'));
        return data
    } catch (err) {
        if (err.code === 'ENOENT') {
            return null
        } else {
            throw err
        }
    }
}

export const progress_callback = (args) => {
    if (args.status != 'progress') return;
    let n = Math.floor(args.progress / 5);
    let str = '\r[' + '#'.repeat(n) + '.'.repeat(20 - n) + '] ' + args.file + (n == 20 ? '\n' : '');
    process.stdout.write(str);
}