import uuid
from pathlib import Path

import fitz
from docx import Document
from fastapi import HTTPException


ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt"}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB


def extract_text_from_txt(file_content: bytes):
    try:
        return file_content.decode("utf-8")

    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail="TXT dosyası UTF-8 formatında okunamadı.",
        )


def extract_text_from_docx(file_path: Path):
    try:
        document = Document(file_path)

        paragraphs = []

        for paragraph in document.paragraphs:
            if paragraph.text.strip():
                paragraphs.append(paragraph.text)

        return "\n".join(paragraphs)

    except Exception:
        raise HTTPException(
            status_code=400,
            detail="DOCX dosyası okunamadı veya dosya bozuk.",
        )


def extract_text_from_pdf(file_path: Path):
    try:
        document = fitz.open(file_path)

        pages = []

        for page in document:
            text = page.get_text()

            if text.strip():
                pages.append(text)

        document.close()

        return "\n".join(pages)

    except Exception:
        raise HTTPException(
            status_code=400,
            detail="PDF dosyası okunamadı veya dosya bozuk.",
        )


def validate_file_extension(filename: str):
    file_extension = Path(filename).suffix.lower()

    if file_extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Sadece PDF, DOCX ve TXT dosyaları yüklenebilir.",
        )

    return file_extension


def validate_file_size(file_content: bytes):
    if len(file_content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail="Dosya boyutu en fazla 10 MB olabilir.",
        )


def save_uploaded_file(
    file_content: bytes,
    file_extension: str,
):
    uploads_directory = Path(__file__).resolve().parent / "uploads"
    uploads_directory.mkdir(parents=True, exist_ok=True)

    unique_filename = f"{uuid.uuid4()}{file_extension}"
    file_path = uploads_directory / unique_filename

    with open(file_path, "wb") as buffer:
        buffer.write(file_content)

    return file_path