import axios from 'axios';
import * as fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { error, PDFDocument } from 'pdf-lib';
import pdf2pic from 'pdf2pic';
import pdfParse from 'pdf-parse';
import {colpaliEmbeddings,colpaliQueryEmbeddings} from './deno_python';
import { insert } from './vespa';
import config from "@/config"
import { python } from "bunpy";

const vespaEndpoint = `http://${config.vespaBaseHost}:8080`

interface PDFProcessingResult {
  texts: string[]
  pageCount: number
}

async function downloadPDF(url: string): Promise<Buffer> {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer'
    });
    return Buffer.from(response.data);
  } catch (error:any) {
    throw new Error(`Failed to download PDF: ${error.message}`);
  }
}

async function extractText(pdfBuffer: Buffer): Promise<{texts: string[], pageCount: number}> {
  try {
    const data = await pdfParse(pdfBuffer);
    const doc = await PDFDocument.load(pdfBuffer);
    const pageCount = doc.getPageCount();
    
    const textPerPage: string[] = [];
    const avgCharsPerPage = data.text.length / pageCount;
    
    for (let i = 0; i < pageCount; i++) {
      const start = Math.floor(i * avgCharsPerPage);
      const end = Math.floor((i + 1) * avgCharsPerPage);
      textPerPage.push(data.text.slice(start, end).trim());
    }
    console.log(textPerPage,"textperpage")
    return {texts: textPerPage, pageCount};
  } catch (error:any) {
    throw new Error(`Failed to extract text: ${error.message}`);
  }
}


export async function getPDFTexts(pdfUrl: string): Promise<PDFProcessingResult> {
  try {
    console.log('Downloading PDF...');
    const pdfBuffer = await downloadPDF(pdfUrl);
    
    console.log('Processing PDF...');
    const {texts,pageCount} = await extractText(pdfBuffer)

    console.log(`Successfully processed ${texts.length} pages`);
    return { texts, pageCount };
  } catch (error:any) {
    throw new Error(`PDF processing failed: ${error.message}`);
  }
}


async function main() {
  const pdf_url = "https://static.conocophillips.com/files/resources/24-0976-sustainability-highlights_nature.pdf"
    try {
      // Do something with the images and texts
      const vespa_doc:any = {}
      const [result,embeddings] = await Promise.all([
        getPDFTexts(pdf_url),
        colpaliEmbeddings({pdf_url}),
      ]) 
      console.log(`Processed ${result.texts.length} pages`);
      // console.log(embeddings["embeddings"][0], 'embeda')
      // if(embeddings['embeddings'].length !== result.pageCount){
      //   throw error("invalid embeddings")
      // }
      const vespa_feed = []
      for (let i=0 ;i< result.pageCount;i++) {
        vespa_doc["docId"] = `${pdf_url}${i}`
        vespa_doc["text"] = result.texts[i]
        vespa_doc["url"] = pdf_url
        vespa_doc["title"] = result.texts[i].slice(0,30)
        vespa_doc["embedding"] = Object.fromEntries(embeddings.embeddings.valueOf()[i])
        vespa_doc["owner"] = "junaid.s@xynehq.com"
        // console.log(vespa_doc["embedding"]," embeddings")

        await insert(vespa_doc,"colpali_pdf")
      }

      // await fs.writeFile("./vespa_pdf_processed.json", JSON.stringify(vespa_feed,null,2))
    } catch (error:any) {
      console.error('Error:', error.message);
    }
}

async function searchVespaDocs(query: string){
  console.log("called")
  try {
    const url = `${vespaEndpoint}/search/`
    const nn = []
    const query_embeds = await colpaliQueryEmbeddings(query);
    const parsedQueryEmbeddings = query_embeds.binary_embeddings.valueOf()
    const parsedQueryFloatEmbeddings = query_embeds.float_embeddings.valueOf()

    const query_tensors:any = {
      "input.query(qtb)": Object.fromEntries(parsedQueryEmbeddings),
      "input.query(qt)": Object.fromEntries(parsedQueryFloatEmbeddings),
    }

    for (const [key, value] of parsedQueryEmbeddings) {
      query_tensors[`input.query(rq${parseInt(key)})`] = value
      nn.push(`({targetHits:${20}}nearestNeighbor(embedding,rq${parseInt(key)}))`)
    }

    const yql = `select url,title from colpali_pdf where ${nn.join(" or ")}`
    // const yql = `select title, url, embedding from colpali_pdf where ({targetHits:${10}}userInput(@query))`
    const hybridDefaultPayload = {
      yql,
      query,
      email:"junaid.s@xynehq.com",
      "ranking.profile": "hybrid",
      hits: 10,
      ...query_tensors
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(hybridDefaultPayload),
      })
      if (!response.ok) {
        const errorText = response.statusText
        throw new Error(
          `Failed to fetch documents in searchVespa: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }
  
      const data = await response.json()
      console.log(data,"data")
      return data
    } catch (error) {
     console.log('ERRoR:', error)
    }
  } catch (error) {
    console.log(error,"error")
  }
}
// main()
searchVespaDocs("How much of produced water is recycled?")