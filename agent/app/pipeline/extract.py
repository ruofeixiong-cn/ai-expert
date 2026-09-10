"""
把各种来源变成纯文本。

这一步放在 agent 而不是 backend，是因为正文提取的工具链（trafilatura /
pymupdf / python-docx）全在 Python 生态。

而且是【同步】调用而不是丢进构建队列 —— 抓不到链接、解析不了文件这类问题
应该在博主点"上传"的那一刻就告诉他，让他改用粘贴正文；等构建时才失败，
体验差得多，而且他已经离开这个页面了。
"""

from __future__ import annotations

import asyncio
import base64
import io
import ipaddress
import re
import socket
from dataclasses import dataclass
from pathlib import PurePosixPath

import httpx

# 抓取超时：宁可快速失败让用户改粘贴正文，也不要让上传接口挂 30 秒
FETCH_TIMEOUT_SECONDS = 12.0
MAX_BYTES = 20 * 1024 * 1024
# 网页比文件小得多：公众号文章的 HTML 一般几百 KB，5MB 已经很宽松
MAX_HTML_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 3
# 公开文章只会在标准端口上。放开任意端口，等于让 agent 帮人探测公网主机上的内部服务
ALLOWED_PORTS = frozenset({80, 443})
# pymupdf 逐页提取是同步 CPU 活，一份上万页的 PDF 能把一个线程占住几分钟
MAX_PDF_PAGES = 500

_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


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


# ─── 链接抓取的 SSRF 防护（B01）───────────────────────────────────────────────
#
# agent 跑在云主机上，同一个网络里有元数据服务（阿里云 100.100.100.200、
# AWS/GCP 169.254.169.254）、Redis、Postgres，以及 agent 自己的 /internal 接口。
# 第一版对博主给的链接照单全收、还自动跟随跳转 —— 粘贴一个元数据地址，
# 实例 RAM 角色的临时凭证就被当成「正文」抓回来入库了。
#
# 四道关：
#   1. 只允许 http / https + 标准端口
#   2. 解析出的【每一个】地址都必须是公网地址
#   3. 连接钉死到校验过的那个 IP。防 DNS rebinding：校验时解析一次、
#      连接时 httpx 再解析一次，攻击者控制的 DNS 可以两次给出不同答案
#   4. 不自动跟随跳转，每一跳重新走 1~3；响应体按上限流式读取


async def _resolve(host: str, port: int) -> list[str]:
    """解析出全部地址。单独成函数，测试可以换掉 DNS。"""
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


def _trusted_networks() -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    """开发机上额外放行的网段（config.FETCH_TRUSTED_CIDRS）。生产环境恒为空。"""
    from app.config import settings

    return [
        ipaddress.ip_network(c.strip()) for c in settings.FETCH_TRUSTED_CIDRS.split(",") if c.strip()
    ]


def _is_public(addr: str) -> bool:
    ip = ipaddress.ip_address(addr.split("%", 1)[0])  # 去掉 IPv6 的 zone id
    # ::ffff:127.0.0.1 这类 IPv4 映射地址，按它映射的那个 IPv4 判断
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    # is_global 已经排除了私网、回环、链路本地（含 169.254 元数据）、
    # 100.64/10 共享地址（含阿里云 100.100.100.200）与各类保留段
    if ip.is_global and not ip.is_multicast:
        return True
    # 本机代理 fake-ip 的网段（198.18.0.0/15）只在开发环境显式放行
    return any(ip in net for net in _trusted_networks())


async def _pin(url: httpx.URL) -> tuple[httpx.URL, str]:
    """校验一个 URL 能不能抓。返回「钉死到 IP 的 URL」和原主机名。"""
    if url.scheme not in ("http", "https"):
        raise ExtractError("只支持 http / https 链接。")
    host = url.raw_host.decode("ascii")
    if not host:
        raise ExtractError("链接里缺少域名，请检查后重试。")
    port = url.port or (443 if url.scheme == "https" else 80)
    if port not in ALLOWED_PORTS:
        raise ExtractError("只支持标准端口（80 / 443）的链接，请改用粘贴正文。")

    try:
        addrs = await _resolve(host, port)
    except OSError as exc:
        raise ExtractError("域名解析失败，请检查链接是否正确。") from exc
    if not addrs or not all(_is_public(a) for a in addrs):
        raise ExtractError("这个链接指向内网或保留地址，不能抓取。")

    return url.copy_with(host=addrs[0]), host


async def _read_capped(resp: httpx.Response) -> bytes:
    too_big = ExtractError("页面太大，请改用粘贴正文。")
    declared = resp.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_HTML_BYTES:
        raise too_big
    buf = bytearray()
    async for chunk in resp.aiter_bytes():
        buf += chunk
        if len(buf) > MAX_HTML_BYTES:
            raise too_big
    return bytes(buf)


async def from_url(url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> Extracted:
    """
    抓网页正文。

    只承诺公众号 —— 知乎、小红书有强反爬，稳定抓取需要持续对抗，
    不是 MVP 该做的事。抓不到时抛出可读原因，前端引导用户粘贴正文。

    `transport` 只给测试用；生产走默认连接。
    """
    import trafilatura

    try:
        target = httpx.URL(url)
    except httpx.InvalidURL as exc:
        raise ExtractError("链接格式不对，请检查后重试。") from exc

    async with httpx.AsyncClient(
        timeout=FETCH_TIMEOUT_SECONDS,
        follow_redirects=False,  # 每一跳都要重新校验，不能交给 httpx 自动跟随
        headers={"user-agent": _USER_AGENT},
        transport=transport,
    ) as client:
        for _ in range(MAX_REDIRECTS + 1):
            pinned, host = await _pin(target)
            try:
                async with client.stream(
                    "GET",
                    pinned,
                    # 连的是 IP，但 Host 头与 TLS 的 SNI / 证书校验仍然用原域名
                    headers={"host": target.netloc.decode("ascii")},
                    extensions={"sni_hostname": host},
                ) as resp:
                    if resp.is_redirect and "location" in resp.headers:
                        target = target.join(resp.headers["location"])
                        continue
                    resp.raise_for_status()
                    html = await _read_capped(resp)
                    break
            except httpx.HTTPStatusError as exc:
                raise ExtractError(
                    f"抓取失败（HTTP {exc.response.status_code}）。该平台可能有访问限制，请改用粘贴正文。"
                ) from exc
            except httpx.HTTPError as exc:
                raise ExtractError("抓取超时或网络不可达，请改用粘贴正文。") from exc
        else:
            raise ExtractError("链接跳转次数过多，请改用粘贴正文。")

    # trafilatura 是同步 CPU 活，放进线程，别占住事件循环（B07）
    text = await asyncio.to_thread(
        trafilatura.extract, html, include_comments=False, include_tables=True
    )
    if not text or len(text.strip()) < 100:
        raise ExtractError("没能从该链接提取到正文（可能需要登录或有反爬），请改用粘贴正文。")

    meta = await asyncio.to_thread(trafilatura.extract_metadata, html)
    title = getattr(meta, "title", None) if meta else None
    return Extracted(title=title, text=_normalize(text))


def from_file(filename: str, content_b64: str) -> Extracted:
    """
    同步函数。⚠️ 调用方必须放进线程执行（`asyncio.to_thread`）——
    pymupdf / python-docx 是 CPU 活，直接在事件循环里跑会卡住所有对话流（B07）。
    """
    # 先按 base64 长度估算原始大小再解码：别为了拒绝一个 500MB 的文件，先把它整个解码进内存
    # 恰好 MAX_BYTES 的文件，base64 是 ceil(MAX_BYTES / 3) * 4 个字符（含补位的 =），
    # 按这个比 —— 别把恰好卡线的文件误拒。与 backend 的 MAX_FILE_BASE64_CHARS 一致
    if len(content_b64) > (MAX_BYTES + 2) // 3 * 4:
        raise ExtractError(f"文件超过 {MAX_BYTES // 1024 // 1024} MB 上限。")

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
                if pdf.page_count > MAX_PDF_PAGES:
                    raise ExtractError(
                        f"这个 PDF 有 {pdf.page_count} 页，超过 {MAX_PDF_PAGES} 页上限，请拆分后上传。"
                    )
                text = "\n\n".join(page.get_text() for page in pdf)
        except ExtractError:
            raise
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
