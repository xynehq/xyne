import torch
from torch.utils.data import DataLoader
from tqdm import tqdm
from io import BytesIO
from colpali_engine.models import ColPali, ColPaliProcessor
from colpali_engine.utils.torch_utils import get_torch_device
from vidore_benchmark.utils.image_utils import scale_image, get_base64_image
import logging
from typing import List, Dict, Any
import requests
import numpy as np
from pdf2image import convert_from_path
from pypdf import PdfReader
import asyncio

device = get_torch_device()
if device == "cuda":
    dtype = torch.bfloat16
else:
    dtype = torch.float32

sample_pdfs = [
    {
        "title": "ConocoPhillips Sustainability Highlights - Nature (24-0976)",
        "url": "https://static.conocophillips.com/files/resources/24-0976-sustainability-highlights_nature.pdf",
    }
]

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def initialize_model():
    """Initialize the ColPali model and processor."""
    global model, processor, device
    
    try:
        device = get_torch_device()
        dtype = torch.bfloat16 if device == "cuda" else torch.float32
        
        model_name = "vidore/colpali-v1.2"
        
        logger.info(f"Loading model on device: {device} with dtype: {dtype}")
        
        model = ColPali.from_pretrained(
            model_name,
            torch_dtype=dtype,
            device_map=device
        ).eval()
        
        processor = ColPaliProcessor.from_pretrained(model_name)
        
        logger.info("Model and processor initialized successfully")
        
    except Exception as e:
        logger.error(f"Failed to initialize model: {str(e)}")
        raise RuntimeError(f"Model initialization failed: {str(e)}")
    
async def startup_event():
    """Initialize model on startup."""
    initialize_model()

async def colpali_image_embeddings(data) -> Dict[str, Any]:

    pdf_url = data.get("pdf_url", [])
    page_images = get_pdf_images(pdf_url)
    page_embeddings = []
    dataloader = DataLoader(
        page_images,
        batch_size=2,
        shuffle=False,
        collate_fn=lambda x: processor.process_images(x),
    )
    for batch_doc in tqdm(dataloader):
        with torch.no_grad():
            batch_doc = {k: v.to(model.device) for k, v in batch_doc.items()}
            embeddings_doc = model(**batch_doc)
            if model.device == "cuda":
                embeddings_doc = embeddings_doc.float()
            page_embeddings.extend(list(torch.unbind(embeddings_doc.to("cpu"))))
    # print(page_embeddings,"page_embedings")

    embeds = []
    for idx, (embedding, image) in enumerate(zip(page_embeddings, page_images)):
        embedding_dict = dict()
        # print(embedding,"embeddxings")
        for idx, patch_embedding in enumerate(embedding):
            binary_vector = (
                np.packbits(np.where(patch_embedding > 0, 1, 0))
                .astype(np.int8)
                .tobytes()
                .hex()
            )
            embedding_dict[idx] = binary_vector
        embeds.append(embedding_dict)
    return {
            "status": "success",
            "embeddings": embeds,
             "metadata": {
                # "num_images": len(image),
                # "embedding_dim": len(embedding[0]) if embedding else 0
            }
    }


def download_pdf(url):
    response = requests.get(url)
    if response.status_code == 200:
        return BytesIO(response.content)
    else:
        raise Exception(f"Failed to download PDF: Status code {response.status_code}")


def get_pdf_images(pdf_url):
    # Download the PDF
    pdf_file = download_pdf(pdf_url)
    # Save the PDF temporarily to disk (pdf2image requires a file path)
    temp_file = "temp.pdf"
    with open(temp_file, "wb") as f:
        f.write(pdf_file.read())

    images = convert_from_path(temp_file)
    return images

queries = [
    # "Percentage of non-fresh water as source?",
    "Policies related to nature risk?",
    # "How much of produced water is recycled?",
]


def get_query_embed():
    dataloader = DataLoader(
    queries,
    batch_size=1,
    shuffle=False,
    collate_fn=lambda x: processor.process_queries(x),
    )
    qs = []
    for batch_query in dataloader:
        with torch.no_grad():
            batch_query = {k: v.to(model.device) for k, v in batch_query.items()}
            embeddings_query = model(**batch_query)
            if model.device == "cuda":
                embeddings_query = embeddings_query.float()
            qs.extend(list(torch.unbind(embeddings_query.to("cpu"))))


    target_hits_per_query_tensor = (
        20  # this is a hyper parameter that can be tuned for speed versus accuracy
    )
    for idx, query in enumerate(queries):
        float_query_embedding = {k: v.tolist() for k, v in enumerate(qs[idx])}
        binary_query_embeddings = dict()
        for k, v in float_query_embedding.items():
            binary_query_embeddings[k] = (
                np.packbits(np.where(np.array(v) > 0, 1, 0)).astype(np.int8).tolist()
            )

        # The mixed tensors used in MaxSim calculations
        # We use both binary and float representations
        query_tensors = {
            "input.query(qtb)": binary_query_embeddings,
            "input.query(qt)": float_query_embedding,
        }
        print(binary_query_embeddings,"binayEmbed")
        # The query tensors used in the nearest neighbor calculations
        for i in range(0, len(binary_query_embeddings)):
            print(binary_query_embeddings[i],'emd')
            query_tensors[f"input.query(rq{i})"] = binary_query_embeddings[i]
        # nn = []
        # for i in range(0, len(binary_query_embeddings)):
        #     nn.append(
        #         f"({{targetHits:{target_hits_per_query_tensor}}}nearestNeighbor(embedding,rq{i}))"
        #     )        

initialize_model()
get_query_embed()

# data = {"pdf_url" : "https://static.conocophillips.com/files/resources/conocophillips-2023-managing-climate-related-risks.pdf" }

# asyncio.run(colpali_image_embeddings(data))