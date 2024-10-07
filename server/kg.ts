
import ollama from 'ollama'
import { getPrompt } from './prompts';
import { checkAndReadFile } from './utils';
const kgCache = './fullDocs.json'
import { getLogger } from '@/shared/logger';
import { LOGGERTYPES } from '@/shared/types';

export const initKG = async () => {

    const Logger = getLogger(LOGGERTYPES.server).child({module: 'kg'})

    let fullDocs = await checkAndReadFile(kgCache)
    if (!fullDocs) {
        fullDocs = []
        const fileMetadata = (await listFiles(userEmail, true)).map(v => {
            v.permissions = toPermissionsList(v.permissions)
            return v
        })
        const googleDocsMetadata = fileMetadata.filter(v => v.mimeType === DriveMime.Docs)
        const docs = google.docs({ version: "v1", auth: jwtClient });
        let count = 0

        for (const doc of googleDocsMetadata) {
            const documentContent = await docs.documents.get({
                documentId: doc.id,
            });
            const rawTextContent = documentContent?.data?.body?.content
                .map((e) => extractText(e))
                .join("");
            const footnotes = extractFootnotes(documentContent.data);
            const headerFooter = extractHeadersAndFooters(documentContent.data);
            const cleanedTextContent = postProcessText(
                rawTextContent + "\n\n" + footnotes + "\n\n" + headerFooter,
            );
            fullDocs.push(cleanedTextContent)
        }

        await fs.writeFile('./fullDocs.json', JSON.stringify(fullDocs))
    }
    Logger.info('doc\n', fullDocs[5])
    const response = await ollama.chat({
        model: 'phi3.5',
        messages: [{ role: 'user', content: getPrompt(fullDocs[5]) }],
        stream: true,
        format: 'json'
    })
    for await (const part of response) {
        process.stdout.write(part.message.content)
    }
}