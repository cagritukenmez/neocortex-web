import uuid
from pathlib import Path

import chromadb


BASE_DIR = Path(__file__).resolve().parent
CHROMA_PATH = BASE_DIR / "chroma_db"

chroma_client = chromadb.PersistentClient(
    path=str(CHROMA_PATH)
)

collection = chroma_client.get_or_create_collection(
    name="documents"
)


def split_text_into_chunks(
    text: str,
    chunk_size: int = 500,
    overlap: int = 100,
):
    chunks = []
    step = chunk_size - overlap

    for i in range(0, len(text), step):
        chunk = text[i:i + chunk_size]

        if chunk.strip():
            chunks.append(chunk)

    return chunks


def retrieve_relevant_chunks(
    question_embedding,
    chat_id: str,
    n_results: int = 5,
):
    results = collection.query(
        query_embeddings=[question_embedding],
        n_results=n_results,
        where={"chat_id": chat_id},
        include=["documents", "metadatas", "distances"],
    )

    if not results["documents"] or not results["documents"][0]:
        return []

    retrieved_chunks = []

    for document, metadata, distance in zip(
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0],
    ):
        retrieved_chunks.append(
            {
                "text": document,
                "filename": metadata["filename"],
                "distance": distance,
            }
        )

    return retrieved_chunks


def store_document_chunks(
    chunks,
    embeddings,
    filename: str,
    chat_id: str,
):
    for index, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
        collection.add(
            ids=[str(uuid.uuid4())],
            documents=[chunk],
            embeddings=[embedding],
            metadatas=[
                {
                    "filename": filename,
                    "chunk_index": index,
                    "chat_id": chat_id,
                }
            ],
        )


def delete_chat_vectors(chat_id: str):
    collection.delete(
        where={"chat_id": chat_id}
    )


def delete_document_vectors(chat_id: str, filename: str):
    collection.delete(
        where={
            "$and": [
                {"chat_id": chat_id},
                {"filename": filename},
            ]
        }
    )