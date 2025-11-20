import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse as parseQs } from 'node:querystring';

const PORT = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 7001;

// 支持通过环境变量自定义 JSON 目录；默认使用项目内 mocks 目录
const MOCK_JSON_DIR = process.env.MOCK_JSON_DIR ?? join(process.cwd(), 'mocks');
import { isStreamEndpoint, resolveStreamFile, sendSseFromFile, MOCK_STREAM_DIR, STREAM_CONFIG_FILE } from './sse.mjs';

function loadJson(filePath) {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
}

function ensureJsonFile(filePath) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(filePath)) {
        const payload = {
            code: 0,
            message: '操作成功',
            data: {},
            timestamp: Date.now(),
        };
        writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    }
}

function ensureDir(dirPath) {
    if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
    }
}


async function readRequestBody(req) {
    return await new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const rawBuffer = Buffer.concat(chunks);
            const raw = rawBuffer.toString('utf-8');
            const contentType = (req.headers['content-type'] || '').toLowerCase();
            let parsed = undefined;
            try {
                if (contentType.includes('application/json')) {
                    parsed = raw ? JSON.parse(raw) : undefined;
                } else if (contentType.includes('application/x-www-form-urlencoded')) {
                    parsed = parseQs(raw);
                } else if (contentType.includes('text/plain') || contentType.includes('application/text')) {
                    parsed = raw;
                } else {
                    // 尝试按 JSON 解析，失败则保留原文字符串
                    parsed = raw ? JSON.parse(raw) : undefined;
                }
            } catch {
                parsed = raw; // 保留原文
            }
            resolve({ raw, parsed, contentType });
        });
        // 没有 body 的 GET/HEAD 会立即触发 end
    });
}

function sanitizePathSegments(pathname) {
    return pathname
        .split('/')
        .filter(Boolean)
        .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, '_'));
}

function timestampFileName(method) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}-${method.toLowerCase()}.json`;
    return name;
}

function writeRequestReport(baseDir, segments, report) {
    const dirPath = join(baseDir, '__requests__', ...segments);
    ensureDir(dirPath);
    const filePath = join(dirPath, timestampFileName(report.method || 'req'));
    writeFileSync(filePath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
}

const server = http.createServer(async (req, res) => {
    const { url } = req;
    const u = new URL(url, 'http://localhost');

    // 健康检查
    if (u.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }

    // 采集请求信息并写入报告文件（按接口路径分目录）
    const bodyInfo = await readRequestBody(req);
    const queryObj = Object.fromEntries(u.searchParams.entries());
    const safeSeg = sanitizePathSegments(u.pathname);
    const report = {
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.url,
        pathname: u.pathname,
        query: queryObj,
        headers: req.headers,
        body: {
            contentType: bodyInfo.contentType,
            raw: bodyInfo.raw,
            parsed: bodyInfo.parsed,
        },
        client: {
            address: req.socket?.remoteAddress,
            port: req.socket?.remotePort,
        },
    };
    try {
        writeRequestReport(MOCK_JSON_DIR, safeSeg, report);
    } catch (e) {
        // 写入报告失败不影响主流程，仅在控制台提示
        console.warn('[mock-server] 写入请求报告失败:', e?.message ?? String(e));
    }

    // 流式响应（SSE）：优先判断并返回
    if (isStreamEndpoint(u.pathname)) {
        const streamFile = resolveStreamFile(MOCK_STREAM_DIR, safeSeg);
        try {
            ensureDir(dirname(streamFile));
            sendSseFromFile(streamFile, res);
            return;
        } catch (e) {
            res.writeHead(500, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-cache',
            });
            res.end(
                JSON.stringify({
                    code: -1,
                    message: `读取流式mock失败: ${e?.message ?? String(e)}`,
                    hint: `请确保 ${streamFile} 存在且为有效的 .sse 或 .json 文件，或设置环境变量 MOCK_STREAM_DIR/STREAM_CONFIG`,
                }),
            );
            return;
        }
    }

    // 动态：按倒数第二段作为子目录，最后一段作为文件名
    const lastSeg = safeSeg.length ? safeSeg[safeSeg.length - 1] : 'index';
    const secondLastSeg = safeSeg.length >= 2 ? safeSeg[safeSeg.length - 2] : null;
    const mockDir = secondLastSeg ? join(MOCK_JSON_DIR, secondLastSeg) : MOCK_JSON_DIR;
    const mockFile = join(mockDir, `${lastSeg}.json`);

    try {
        ensureJsonFile(mockFile);
        const payload = loadJson(mockFile);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache',
        });
        res.end(JSON.stringify(payload));
    } catch (e) {
        res.writeHead(500, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache',
        });
        res.end(
            JSON.stringify({
                code: -1,
                message: `读取mock JSON失败: ${e?.message ?? String(e)}`,
                hint: `请确保 ${mockFile} 为有效JSON，或设置环境变量MOCK_JSON_DIR 指向存储目录`,
            }),
        );
    }
});

server.listen(PORT, () => {
    console.log(`[mock-server] listening on http://localhost:${PORT}`);
    console.log('[mock-server] mode: dir=倒数第二段/文件=最后一段 (*.json)');
    console.log(`[mock-server] data directory: ${MOCK_JSON_DIR}`);
    console.log(`[mock-server] stream directory: ${MOCK_STREAM_DIR}`);
    if (existsSync(STREAM_CONFIG_FILE)) {
        console.log(`[mock-server] stream config: ${STREAM_CONFIG_FILE}`);
    } else {
        console.log('[mock-server] stream config: 未设置（默认匹配以 /stream 结尾的路径）');
    }
});
