"""
把各种来源变成纯文本。

这一步放在 agent 而不是 backend，是因为正文提取的工具链（trafilatura /
pymupdf / python-docx）全在 Python 生态。

而且是【同步】调用而不是丢进构建队列 —— 抓不到链接、解析不了文件这类问题
应该在博主点"上传"的那一刻就告诉他，让他改用粘贴正文；等构建时才失败，
体验差得多，而且他已经离开这个页面了。
"""

from __future__ import annotations

import base64
import io
import re
from dataclasses import dataclass
from pathlib import PurePosixPath

import httpx

# 抓取超时：宁可快速失败让用户改粘贴正文，也不要让上传接口挂 30 秒
FETCH_TIMEOUT_SECONDS = 12.0
MAX_BYTES = 20 * 1024 * 1024


class ExtractError(Exception):
    """可以直接展示给用户的失败原因。"""


@dataclass
class Extracted:
    title: str | None
    text: str


def _normalize(text: str) -> str:
    # 统一换行、压掉三个以上的连续空行、去掉行尾空格
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


async def from_url(url: str) -> Extracted:
    """
    抓网页正文。

    只承诺公众号 —— 知乎、小红书有强反爬，稳定抓取需要持续对抗，
    不是 MVP 该做的事。抓不到时抛出可读原因，前端引导用户粘贴正文。
    """
    import trafilatura

    try:
        async with httpx.AsyncClient(
            timeout=FETCH_TIMEOUT_SECONDS,
            follow_redirects=True,
            headers={
                "user-agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
                )
            },
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            html = resp.text
    except httpx.HTTPStatusError as exc:
        raise ExtractError(
            f"抓取失败（HTTP {exc.response.status_code}）。该平台可能有访问限制，请改用粘贴正文。"
        ) from exc
    except httpx.HTTPError as exc:
        raise ExtractError("抓取超时或网络不可达，请改用粘贴正文。") from exc

    text = trafilatura.extract(html, include_comments=False, include_tables=True)
    if not text or len(text.strip()) < 100:
        raise ExtractError("没能从该链接提取到正文（可能需要登录或有反爬），请改用粘贴正文。")

    meta = trafilatura.extract_metadata(html)
    title = getattr(meta, "title", None) if meta else None
    return Extracted(title=title, text=_normalize(text))


def from_file(filename: str, content_b64: str) -> Extracted:
    try:
        blob = base64.b64decode(content_b64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ExtractError("文件内容不是合法的 base64。") from exc

    if len(blob) > MAX_BYTES:
        raise ExtractError(f"文件超过 {MAX_BYTES // 1024 // 1024} MB 上限。")

    suffix = PurePosixPath(filename).suffix.lower()
    title = PurePosixPath(filename).stem or None

    if suffix in {".md", ".markdown", ".txt", ".text", ""}:
        try:
            text = blob.decode("utf-8")
        except UnicodeDecodeError:
            # 中文 Windows 导出的 txt 常见编码
            try:
                text = blob.decode("gb18030")
            except UnicodeDecodeError as exc:
                raise ExtractError("无法识别文件编码，请另存为 UTF-8 后重试。") from exc

    elif suffix == ".docx":
        import docx  # python-docx

        try:
            doc = docx.Document(io.BytesIO(blob))
        except Exception as exc:  # noqa: BLE001
            raise ExtractError("这个 .docx 打不开，可能已损坏或其实是 .doc 旧格式。") from exc
        text = "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())

    elif suffix == ".pdf":
        import pymupdf

        try:
            with pymupdf.open(stream=blob, filetype="pdf") as pdf:
                text = "\n\n".join(page.get_text() for page in pdf)
        except Exception as exc:  # noqa: BLE001
            raise ExtractError("这个 PDF 打不开，可能已加密或已损坏。") from exc
        if len(text.strip()) < 100:
            # 扫描件是图片，没有文字层。OCR 是二期的事。
            raise ExtractError(
                "这个 PDF 里没有可提取的文字（可能是扫描件）。MVP 暂不支持 OCR，请改用粘贴正文。"
            )
    else:
        raise ExtractError(f"暂不支持 {suffix or '该'} 格式，支持 .md / .txt / .docx / .pdf。")

    text = _normalize(text)
    if len(text) < 20:
        raise ExtractError("文件里几乎没有文字内容。")
    return Extracted(title=title, text=text)
