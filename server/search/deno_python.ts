import { python } from "bunpy";

const { colpaliEmbeddings,colpaliQueryEmbeddings } = python.runModule(`
import torch
from torch.utils.data import DataLoader
from tqdm import tqdm
from io import BytesIO
import requests
import numpy as np
from pdf2image import convert_from_path
from colpali_engine.models import ColPali, ColPaliProcessor
from colpali_engine.utils.torch_utils import get_torch_device
import json
class ColPaliService:
    def __init__(self):
        self.device = get_torch_device()
        self.dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
        self.model_name = "vidore/colpali-v1.2"
        
        self.model = ColPali.from_pretrained(
            self.model_name,
            torch_dtype=self.dtype,
            device_map=self.device
        ).eval()
        
        self.processor = ColPaliProcessor.from_pretrained(self.model_name)
    
    def download_pdf(self, url):
        response = requests.get(url)
        if response.status_code == 200:
            return BytesIO(response.content)
        else:
            raise Exception(f"Failed to download PDF: Status code {response.status_code}")
    
    def get_pdf_images(self, pdf_url):
        pdf_file = self.download_pdf(pdf_url)
        temp_file = "temp.pdf"
        with open(temp_file, "wb") as f:
            f.write(pdf_file.read())
        return convert_from_path(temp_file)
    
    def process_embeddings(self, page_images):
        page_embeddings = []
        dataloader = DataLoader(
            page_images,
            batch_size=2,
            shuffle=False,
            collate_fn=lambda x: self.processor.process_images(x),
        )
        
        for batch_doc in tqdm(dataloader):
            with torch.no_grad():
                batch_doc = {k: v.to(self.model.device) for k, v in batch_doc.items()}
                embeddings_doc = self.model(**batch_doc)
                if self.model.device == "cuda":
                    embeddings_doc = embeddings_doc.float()
                page_embeddings.extend(list(torch.unbind(embeddings_doc.to("cpu"))))
        return page_embeddings
    
    def colpali_query_embeddings(self,query):
        processed_query = self.processor.process_queries([query]).to(self.model.device)
        # processed_query = {k: v.to(self.model.device) for k, v in processed_query.items()}
        with torch.no_grad():
            embedding_query = self.model(**processed_query).to("cpu")[0]
            if self.model.device == "cuda":
                embedding_query = embedding_query.float()
        return embedding_query

def colpaliEmbeddings(data):
    service = ColPaliService()
    
    pdf_url = data.get("pdf_url")
    if not pdf_url:
        raise ValueError("PDF URL is required")
        
    page_images = service.get_pdf_images(pdf_url)
    page_embeddings = service.process_embeddings(page_images)
    
    embeds = []
    for idx, embedding in enumerate(page_embeddings):
        embedding_dict = {}
        for idx, patch_embedding in enumerate(embedding):
            binary_vector = (
                np.packbits(np.where(patch_embedding > 0, 1, 0))
                .astype(np.int8)
                .tobytes()
                .hex()
            )
            embedding_dict[idx] = binary_vector
        embeds.append(embedding_dict)
    
    return json.loads(json.dumps({
        "status": "success",
        "embeddings": embeds
    }))

def colpaliQueryEmbeddings(query):
    service = ColPaliService()

    qs = service.colpali_query_embeddings(query)
    float_query_embedding = {k: v.tolist() for k, v in enumerate(qs)}
    binary_query_embeddings = dict()
    for k, v in float_query_embedding.items():
        binary_query_embeddings[k] = (
            np.packbits(np.where(np.array(v) > 0, 1, 0)).astype(np.int8).tolist()
        )

    return json.loads(json.dumps({
        "float_embeddings": float_query_embedding,
        "binary_embeddings": binary_query_embeddings
    }))
`);


export { colpaliEmbeddings, colpaliQueryEmbeddings }
// Usage example
// const data = {
//     pdf_url: "https://static.conocophillips.com/files/resources/24-0976-sustainability-highlights_nature.pdf"
// };


// try {
//     const result = await colpaliEmbeddings(data);
//     console.log(result["embeddings"],'results');
// } catch (error) {
//     console.error("Error processing PDF:", error);
// }