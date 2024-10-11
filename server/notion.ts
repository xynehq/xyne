
import { getLogger } from './shared/logger';
import { Subsystem } from '@/shared/types';
import { Client } from '@notionhq/client';
import { crawler, pageToString } from "notion-md-crawler";

const notionApiKey = process.env.NOTION_API_KEY
const notion = new Client({
    auth: notionApiKey
})

const Logger =  getLogger(Subsystem.notion)
const notionPagesToFiles = async (pages): Promise<File[]> => {
    const crawl = crawler({ client: notion })
    let notionDocs = []

    let count = 0
    for (const page of pages) {
        let permissions = ['saheb@xynehq.com']
        if (page.user.person.email !== 'saheb@xynehq.com') {
            permissions.push(page.user.person.email)
        }
        let pageText = ''
        //  Logger.info(`crawing , ${page.id`})
        for await (const result of crawl(page.id)) {
            count += 1
            console.clear()
            process.stdout.write(`${page.id} ${count} ${Math.floor((count / pages.length) * 100)}`)
            if (result.success) {
                //  Logger.info(`crawling successful:  ${result.id}`)
                pageText = pageToString(result.page);

                const chunks = chunkDocument(pageText)
                for (const { chunk, chunkIndex } of chunks) {
                    notionDocs.push({
                        chunk,
                        chunkIndex,
                        docId: result.page.id || result.page.metadata.id,
                        title: result.page.title || result.page.metadata.title,
                        app: 'notion',
                        entity: 'page',
                        url: page.url,
                        owner: page.user.name,
                        photoLink: page.user.avatar_url,
                        ownerEmail: page.user.person.email,
                        permissions,
                        mimeType: 'page'
                    })

                }
            } else {
                Logger.info('crawling failed')
            }
        }
    }
    return notionDocs
}

const getNotionData = async () => {
    const users = await notion.users.list({})
    let userMap = {}
    for (const user of users.results.filter(u => u.type !== 'bot')) {
        userMap[user.id] = user
    }
    Logger.info('found all users')
    let start_cursor = undefined
    let docs = []
    while (true) {
        let notionDocs
        notionDocs = await notion.search({ start_cursor })
        docs = docs.concat(notionDocs.results)
        if (notionDocs.has_more) {
            start_cursor = notionDocs.next_cursor
        } else {
            break
        }
        console.clear()
        process.stdout.write(`${docs.length}`)
    }
    docs.map(doc => {
        const user = userMap[doc.created_by.id]
        doc.user = user
        return doc
    })
    return docs
}


const notionCachePath = './notionData.json'
export const initNotion = async () => {
    let data = await checkAndReadFile(notionCachePath)
    if (!data) {
        const docs = await getNotionData()
        const pages = docs.filter(v => v.object === "page")
        Logger.info(`got notion pages: , ${pages.length}`)
        const finalData = await notionPagesToFiles(pages)
        Logger.info('started vectorizing')
        let c = 0
        data = await Promise.all([...finalData].map(async (doc, i) => ({
            properties: {
                ...doc
            },
            vectors: (await extractor(getVectorStr(doc.title, doc.chunk), { pooling: 'mean', normalize: true })).tolist()[0],  // Add the generated vector
        })));
        Logger.info('vectorizing done')
        fs.writeFile('./notionData.json', JSON.stringify(finalData))
    }
    let processed = 0
    const batchSize = 20
    for (var i = 0; i < data.length; i += batchSize) {
        const part = data.slice(i, i + batchSize)
        const inserted = await collection.data.insertMany(part);
        processed += part.length
        Logger.info(`inserting chunks: ', ${processed}`)
    }
}