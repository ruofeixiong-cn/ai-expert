"""
B01：链接抓取的 SSRF 防护。B07：素材解析不阻塞事件循环。

B01 的风险不是理论上的：agent 跑在 ECS 上，博主只要粘贴
`http://100.100.100.200/latest/meta-data/...`（阿里云元数据地址），
第一版就会把实例 RAM 角色的 STS 凭证当成正文抓回来入库，
博主在素材列表里就能看到。

这里全部离线：DNS 与 HTTP 都换成假的，不发任何真实请求。
"""

import base64
import threading

import httpx
import pytest

from app.pipeline import extract as ex

PUBLIC = "93.184.216.34"
ARTICLE = (
    "<html><head><title>定投的手续费</title></head><body><article><h1>定投的手续费</h1>"
    + "<p>定投的手续费会吃掉近两成收益，所以要选费率低的渠道，持有满两年还能免掉赎回费。</p>" * 12
    + "</article></body></html>"
)


@pytest.fixture
def dns(monkeypatch):
    """假 DNS：测试往这张表里填「域名 → 解析出的地址」。"""
    table: dict[str, list[str]] = {}

    async def fake_resolve(host: str, port: int) -> list[str]:
        if host not in table:
            raise OSError(f"NXDOMAIN {host}")
        return table[host]

    monkeypatch.setattr(ex, "_resolve", fake_resolve)
    return table


def recording(handler, seen: list):
    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    return httpx.MockTransport(wrapped)


def never_called(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"不该发出请求：{request.url}")


# ─── B01 ─────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "url, ips",
    [
        ("http://100.100.100.200/latest/meta-data/ram/security-credentials/", ["100.100.100.200"]),
        ("http://169.254.169.254/latest/meta-data/", ["169.254.169.254"]),
        ("http://localhost/internal/health", ["127.0.0.1"]),
        ("http://intranet.example.com/", ["10.0.0.5"]),
        # 解析出多个地址时，只要有一个不是公网就拒 —— 否则连接时可能恰好选中它
        ("http://mixed.example.com/", [PUBLIC, "192.168.1.1"]),
        ("http://mapped.example.com/", ["::ffff:127.0.0.1"]),
        ("http://v6.example.com/", ["::1"]),
    ],
)
async def test_internal_targets_are_refused_before_any_request(dns, url, ips):
    dns[httpx.URL(url).host] = ips
    seen: list = []
    with pytest.raises(ex.ExtractError, match="内网"):
        await ex.from_url(url, transport=recording(never_called, seen))
    assert seen == []


@pytest.mark.parametrize("url", ["file:///etc/passwd", "gopher://example.com/", "ftp://example.com/a"])
async def test_only_http_and_https(dns, url):
    with pytest.raises(ex.ExtractError, match="http"):
        await ex.from_url(url, transport=recording(never_called, []))


async def test_non_standard_port_is_refused(dns):
    dns["redis.example.com"] = [PUBLIC]
    with pytest.raises(ex.ExtractError, match="端口"):
        await ex.from_url("http://redis.example.com:6379/", transport=recording(never_called, []))


async def test_redirect_into_intranet_is_refused(dns):
    """公网地址 302 到内网 —— 最常见的绕过手法。跳转目标必须重新校验。"""
    dns["mp.weixin.qq.com"] = [PUBLIC]
    dns["169.254.169.254"] = ["169.254.169.254"]
    seen: list = []

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"})

    with pytest.raises(ex.ExtractError, match="内网"):
        await ex.from_url("https://mp.weixin.qq.com/s/abc", transport=recording(handler, seen))
    assert len(seen) == 1  # 跳转目标一次都没有被请求


async def test_too_many_redirects(dns):
    dns["loop.example.com"] = [PUBLIC]
    seen: list = []

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "/next"})

    with pytest.raises(ex.ExtractError, match="跳转"):
        await ex.from_url("https://loop.example.com/", transport=recording(handler, seen))
    assert len(seen) == ex.MAX_REDIRECTS + 1


async def test_request_is_pinned_to_the_checked_ip(dns):
    """
    防 DNS rebinding：校验时解析一次、连接时 httpx 再解析一次，两次结果可以不同。
    所以实际连接必须用校验过的那个 IP，Host 与 TLS 的 SNI 仍然是原域名。
    """
    dns["mp.weixin.qq.com"] = [PUBLIC]
    seen: list = []

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, html=ARTICLE)

    result = await ex.from_url("https://mp.weixin.qq.com/s/abc", transport=recording(handler, seen))

    req = seen[0]
    assert req.url.host == PUBLIC
    assert req.headers["host"] == "mp.weixin.qq.com"
    assert req.extensions["sni_hostname"] == "mp.weixin.qq.com"
    assert "手续费" in result.text


async def test_oversized_page_is_refused(dns, monkeypatch):
    monkeypatch.setattr(ex, "MAX_HTML_BYTES", 1024)
    dns["big.example.com"] = [PUBLIC]

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 4096)

    with pytest.raises(ex.ExtractError, match="太大"):
        await ex.from_url("https://big.example.com/", transport=recording(handler, []))


# ─── B07 ─────────────────────────────────────────────────────────────────────

async def test_file_parsing_runs_off_the_event_loop(monkeypatch):
    """
    pymupdf / python-docx 是同步 CPU 活。第一版直接在 async handler 里跑，
    解析一个大 PDF 的这段时间，同一进程里所有粉丝的对话流全部停住。
    """
    from app.config import settings
    from app.main import app

    ran_on_main: list[bool] = []

    def fake_from_file(filename: str, content_b64: str) -> ex.Extracted:
        ran_on_main.append(threading.current_thread() is threading.main_thread())
        return ex.Extracted(title="t", text="正文" * 20)

    monkeypatch.setattr(ex, "from_file", fake_from_file)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent") as c:
        r = await c.post(
            "/internal/extract",
            headers={"x-internal-token": settings.INTERNAL_TOKEN},
            json={
                "source_type": "file",
                "filename": "a.txt",
                "content_base64": base64.b64encode(b"x").decode(),
            },
        )

    assert r.status_code == 200
    assert ran_on_main == [False]


def test_oversized_file_is_refused_before_decoding(monkeypatch):
    """按 base64 长度先估算大小，别为了拒绝一个 500MB 的文件先把它解码进内存。"""
    decoded: list[int] = []
    monkeypatch.setattr(ex.base64, "b64decode", lambda *a, **k: decoded.append(1))

    too_big = "A" * (ex.MAX_BYTES // 3 * 4 + 8)
    with pytest.raises(ex.ExtractError, match="上限"):
        ex.from_file("a.pdf", too_big)
    assert decoded == []


def test_pdf_page_count_is_capped(monkeypatch):
    import pymupdf

    monkeypatch.setattr(ex, "MAX_PDF_PAGES", 3)
    doc = pymupdf.open()
    for _ in range(5):
        doc.new_page()
    b64 = base64.b64encode(doc.tobytes()).decode()

    with pytest.raises(ex.ExtractError, match="页"):
        ex.from_file("a.pdf", b64)


# ─── 开发机上的代理 fake-ip ───────────────────────────────────────────────────
#
# 实现 B01 之后在本机实测才发现：开着 Clash / Surge 的 fake-ip 模式时，
# 所有域名都解析到 198.18.0.0/15（保留地址），链接导入在本地全部失效。

async def test_fake_ip_range_can_be_trusted_in_development(dns, monkeypatch):
    from app.config import settings

    dns["mp.weixin.qq.com"] = ["198.18.0.65"]
    with pytest.raises(ex.ExtractError, match="内网"):
        await ex.from_url("https://mp.weixin.qq.com/s/abc", transport=recording(never_called, []))

    monkeypatch.setattr(settings, "FETCH_TRUSTED_CIDRS", "198.18.0.0/15")
    seen: list = []
    result = await ex.from_url(
        "https://mp.weixin.qq.com/s/abc",
        transport=recording(lambda r: httpx.Response(200, html=ARTICLE), seen),
    )
    assert seen[0].url.host == "198.18.0.65"
    assert "手续费" in result.text


async def test_trusting_the_proxy_range_does_not_open_metadata(dns, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "FETCH_TRUSTED_CIDRS", "198.18.0.0/15")
    dns["100.100.100.200"] = ["100.100.100.200"]
    with pytest.raises(ex.ExtractError, match="内网"):
        await ex.from_url(
            "http://100.100.100.200/latest/meta-data/", transport=recording(never_called, [])
        )
